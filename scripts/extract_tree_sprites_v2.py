#!/usr/bin/env python3
"""
Extract tree sprites from RCT2 DAT files with proper in-game names.
Version 2: Extracts real names from DAT files and validates against scenery groups.

Usage:
    python3 scripts/extract_tree_sprites_v2.py

Output:
    ~/Desktop/rct_trees/<Tree Name>/
        00.png, 01.png, ... (sprite frames)
"""

import os
import re
import shutil
import struct
import subprocess
import sys
from pathlib import Path

# Configuration
RCT2_OBJDATA = Path(os.path.expanduser("~/rct2_files/ObjData"))
OPENRCT2_BIN = Path(os.path.expanduser("~/Desktop/OpenRCT2/build/OpenRCT2.app/Contents/MacOS/OpenRCT2"))
OUTPUT_DIR = Path(os.path.expanduser("~/Desktop/rct_trees"))


def parse_scenery_group(dat_path: Path) -> list[str]:
    """Parse a scenery group DAT file to extract referenced object codes."""
    with open(dat_path, "rb") as f:
        data = f.read()

    codes = []
    i = 0
    while i < len(data) - 10:
        # Look for the pattern: 81 fe 00 XX [code bytes] terminator
        # XX = length - 1 (so actual length = XX + 1)
        # Terminators: fc=3char, fd=4char, fe=5char, ff=6char
        if data[i] == 0x81 and data[i+1] == 0xFE and data[i+2] == 0x00:
            length_minus_one = data[i+3]
            actual_length = length_minus_one + 1

            if 0 < actual_length <= 8:
                code_start = i + 4
                code_bytes = []

                for j in range(actual_length):
                    if code_start + j >= len(data):
                        break
                    b = data[code_start + j]
                    # Stop at terminators
                    if b in (0xFC, 0xFD, 0xFE, 0xFF, 0x20):
                        break
                    if 32 <= b < 127:
                        code_bytes.append(chr(b))

                if code_bytes:
                    code = "".join(code_bytes).strip()
                    if code and len(code) >= 2:
                        codes.append(code)

            i += 4 + actual_length
        else:
            i += 1

    return codes


def extract_english_name(dat_path: Path) -> str:
    """Extract the English name from a DAT file's string table."""
    with open(dat_path, "rb") as f:
        data = f.read()

    # Find the string table by looking for the 0xF3 marker
    # The pattern is: ... F3 00 [language_code] [string] 00 ...
    string_table_start = None
    for i in range(0x18, min(len(data) - 2, 100)):
        if data[i] == 0xF3 and data[i+1] == 0x00:
            string_table_start = i + 2
            break

    if string_table_start is None:
        return dat_path.stem

    # Parse strings: each is [language_code] [null-terminated string]
    # Language codes: 0x00=English UK, 0x01=English US, 0xFF=end
    offset = string_table_start
    english_name = None

    while offset < min(len(data) - 1, string_table_start + 500):
        lang_code = data[offset]

        if lang_code == 0xFF:
            # End of string table
            break

        # Find the null-terminated string
        str_start = offset + 1
        str_end = str_start
        while str_end < len(data) and data[str_end] != 0:
            str_end += 1

        if str_end > str_start:
            raw = data[str_start:str_end]
            name = decode_rct2_string(raw)

            # Language codes 0x00 and 0x01 are English
            if lang_code in (0x00, 0x01) and name and len(name) >= 2:
                # Check if it looks like English (contains common English chars)
                if any(c in name for c in 'aeiouAEIOU'):
                    english_name = name
                    break

        # Move to next string
        offset = str_end + 1

    return english_name or dat_path.stem


def decode_rct2_string(data: bytes) -> str:
    """
    Decode an RCT2 string.

    RCT2 uses 0xFF as an escape character followed by 2 bytes.
    The FIRST byte after 0xFF is typically the ASCII character.
    The second byte is a formatting/color code.
    """
    result = []
    i = 0
    while i < len(data):
        b = data[i]
        if b == 0:
            break
        if b == 0xFF and i + 2 < len(data):
            # The first byte after 0xFF is the actual character
            char_byte = data[i + 1]
            if 32 <= char_byte < 127:
                result.append(chr(char_byte))
            i += 3  # Skip 0xFF + 2 parameter bytes
        elif 32 <= b < 127:
            result.append(chr(b))
            i += 1
        elif b >= 128:
            # Windows-1252 extended character
            try:
                result.append(bytes([b]).decode("cp1252"))
            except:
                pass
            i += 1
        else:
            i += 1

    name = "".join(result).strip()

    # Fix common encoding artifacts where double letters get collapsed
    # These patterns are consistent in RCT2 tree names
    name = re.sub(r'\bTre\b', 'Tree', name)  # "Tre" at word boundary -> "Tree"
    name = re.sub(r'Cypres\b', 'Cypress', name)  # "Cypres" -> "Cypress"
    name = re.sub(r'Puzle\b', 'Puzzle', name)  # "Puzle" -> "Puzzle"
    name = re.sub(r'\bComon\b', 'Common', name)  # "Comon" -> "Common"
    name = re.sub(r'\bAlepo\b', 'Aleppo', name)  # "Alepo" -> "Aleppo"
    name = re.sub(r'Laburnam\b', 'Laburnum', name)  # "Laburnam" -> "Laburnum"
    name = re.sub(r'\bCabage\b', 'Cabbage', name)  # "Cabage" -> "Cabbage"

    return name


def find_dat_file(code: str) -> Path | None:
    """Find the DAT file for a given object code."""
    # Try with different padding
    for padding in ["", " ", "  ", "   ", "    "]:
        padded = code + padding
        dat_file = RCT2_OBJDATA / f"{padded}.DAT"
        if dat_file.exists():
            return dat_file

    # Case-insensitive search
    code_upper = code.upper()
    for f in RCT2_OBJDATA.iterdir():
        if f.suffix.upper() == ".DAT":
            stem = f.stem.rstrip().upper()
            if stem == code_upper:
                return f

    return None


def sanitize_filename(name: str) -> str:
    """Convert a name to a safe filename."""
    name = re.sub(r'[<>:"/\\|?*]', "_", name)
    name = name.strip()
    return name or "Unknown"


def export_sprites(dat_path: Path, output_name: str) -> bool:
    """Export sprites from a DAT file using OpenRCT2."""
    output_path = OUTPUT_DIR / sanitize_filename(output_name)

    if output_path.exists():
        shutil.rmtree(output_path)
    output_path.mkdir(parents=True, exist_ok=True)

    try:
        result = subprocess.run(
            [str(OPENRCT2_BIN), "sprite", "exportobject", str(dat_path), str(output_path)],
            capture_output=True,
            text=True,
            timeout=60
        )

        pngs = list(output_path.glob("*.png"))
        if pngs:
            return True
        else:
            output_path.rmdir()
            return False

    except Exception as e:
        print(f"  Error: {e}")
        return False


def main():
    print("RCT2 Tree Sprite Extractor v2")
    print("=" * 50)

    if not RCT2_OBJDATA.exists():
        print(f"Error: RCT2 ObjData not found at {RCT2_OBJDATA}")
        sys.exit(1)

    if not OPENRCT2_BIN.exists():
        print(f"Error: OpenRCT2 not found at {OPENRCT2_BIN}")
        sys.exit(1)

    # Collect tree codes from multiple scenery groups
    all_tree_codes = []
    scenery_groups = [
        ("SCGTREES", "Trees"),
        ("SCGJUNGL", "Jungle"),
        ("SCGSNOW", "Snow"),
    ]

    for group_code, group_name in scenery_groups:
        group_path = find_dat_file(group_code)
        if group_path:
            codes = parse_scenery_group(group_path)
            print(f"{group_name} ({group_code}): {len(codes)} objects")
            all_tree_codes.extend(codes)
        else:
            print(f"{group_name} ({group_code}): not found")

    # Remove duplicates while preserving order
    seen = set()
    unique_codes = []
    for code in all_tree_codes:
        if code not in seen:
            seen.add(code)
            unique_codes.append(code)

    print(f"\nTotal unique objects: {len(unique_codes)}")

    # Clean old output
    if OUTPUT_DIR.exists():
        shutil.rmtree(OUTPUT_DIR)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    success_count = 0
    fail_count = 0
    not_found = []
    used_names = {}  # Track used names to handle duplicates

    print(f"Extracting to: {OUTPUT_DIR}\n")

    for code in unique_codes:
        dat_path = find_dat_file(code)
        if not dat_path:
            not_found.append(code)
            print(f"  {code}: not found")
            continue

        # Get the real English name from the DAT file
        base_name = extract_english_name(dat_path)

        # Handle duplicate names by appending a number
        name = base_name
        if base_name in used_names:
            used_names[base_name] += 1
            name = f"{base_name} ({used_names[base_name]})"
        else:
            used_names[base_name] = 1

        print(f"{code}: \"{name}\"")

        if export_sprites(dat_path, name):
            success_count += 1
            print(f"  -> {sanitize_filename(name)}/")
        else:
            fail_count += 1
            print(f"  -> Failed")

    print("\n" + "=" * 50)
    print(f"Exported: {success_count}")
    print(f"Failed: {fail_count}")
    if not_found:
        print(f"Not found: {', '.join(not_found)}")
    print(f"\nOutput: {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
