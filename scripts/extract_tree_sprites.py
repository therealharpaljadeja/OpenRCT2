#!/usr/bin/env python3
"""
Extract tree sprites from RCT2 DAT files with proper in-game names.

Usage:
    python3 scripts/extract_tree_sprites.py

Output:
    ~/Desktop/rct_trees/<Tree Name>/
        00.png, 01.png, ... (sprite frames)
"""

import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

# Configuration
RCT2_OBJDATA = Path(os.path.expanduser("~/rct2_files/ObjData"))
OPENRCT2_BIN = Path(os.path.expanduser("~/Desktop/OpenRCT2/build/OpenRCT2.app/Contents/MacOS/OpenRCT2"))
OUTPUT_DIR = Path(os.path.expanduser("~/Desktop/rct_trees"))

# Mapping of tree object codes to their English names
# Based on RCT2 game data
TREE_NAMES = {
    # Trees Scenery Group (SCGTREES)
    "TIC": "Incense Cedar Tree",
    "TLC": "Lawson Cypress Tree",
    "TMC": "Chinese Cedar Tree",
    "TMP": "Monkey-Puzzle Tree",
    "TITC": "Italian Cypress Tree",
    "TGHC": "Grand Hinoki Tree",
    "TAC": "Austrian Pine Tree",
    "TGHC2": "Weeping Grand Hinoki Tree",
    "TCJ": "Japanese Cedar Tree",
    "TMBJ": "Maritime Pine Tree",
    "TCF": "Caucasian Fir Tree",
    "TCL": "Cedar of Lebanon Tree",
    "TRF": "Blue Douglas Fir Tree",
    "TRF2": "Rocky Mountain Fir Tree",
    "TEL": "European Larch Tree",
    "TAP": "Aleppo Pine Tree",
    "TSP": "Scots Pine Tree",
    "TMZP": "Montezuma Pine Tree",
    "TCRP": "Corsican Pine Tree",
    "TBP": "Black Poplar Tree",
    "TLP": "Lombardy Poplar Tree",
    "TWP": "White Poplar Tree",
    "TAS": "Aspen Tree",
    "TMG": "Magnolia Tree",
    "TSB": "Swamp Birch Tree",
    "TVL": "Virginia Live Oak Tree",
    "TCY": "Common Yew Tree",
    "TNS": "Norway Spruce Tree",
    "TWN": "Walnut Tree",
    "TCE": "Common Elm Tree",
    "TCO": "Common Oak Tree",
    "THL": "Hornbeam Tree",
    "TF1": "Fruit Tree",
    "TF2": "Fruit Tree 2",
    "TCT": "Ash Tree",
    "TH1": "Canary Palm Tree",
    "TH2": "Palm Tree",
    "TPM": "Hiba Tree",
    "TROPT1": "Tropical Tree",

    # Jungle Theme Trees
    "TJT1": "Jungle Tree 1",
    "TJT2": "Jungle Tree 2",
    "TJT3": "Jungle Tree 3",
    "TJT4": "Jungle Tree 4",
    "TJT5": "Jungle Tree 5",
    "TJT6": "Jungle Tree 6",
    "TJB1": "Jungle Bush 1",
    "TJB2": "Jungle Bush 2",
    "TJB3": "Jungle Bush 3",
    "TJB4": "Jungle Bush 4",
    "TJP1": "Jungle Palm 1",
    "TJP2": "Jungle Palm 2",

    # Snow Theme Trees
    "TS0": "Snow Tree 1",
    "TS1": "Snow Tree 2",
    "TS2": "Snow Tree 3",
    "TS3": "Snow Tree 4",
    "TS4": "Snow Tree 5",
    "TS5": "Snow Tree 6",
    "TS6": "Snow Tree 7",
    "TSC2": "Snow Cactus",
    "TSF1": "Snow Fir Tree 1",
    "TSF2": "Snow Fir Tree 2",
    "TSF3": "Snow Fir Tree 3",

    # Other Trees
    "TK1": "Dead Tree 1",
    "TK2": "Dead Tree 2",
    "TK3": "Dead Tree 3",
    "TK4": "Dead Tree 4",
    "TL0": "Ornamental Tree 1",
    "TL1": "Ornamental Tree 2",
    "TL2": "Ornamental Tree 3",
    "TL3": "Ornamental Tree 4",
    "TM0": "Candy Tree 1",
    "TM1": "Candy Tree 2",
    "TM2": "Candy Tree 3",
    "TM3": "Candy Tree 4",
    "TMM1": "Maple Tree 1",
    "TMM2": "Maple Tree 2",
    "TMM3": "Maple Tree 3",
    "TMO1": "Oak Tree 1",
    "TMO2": "Oak Tree 2",
    "TMO3": "Oak Tree 3",
    "TMO4": "Oak Tree 4",
    "TMO5": "Oak Tree 5",
    "TMS1": "Misc Tree 1",
    "TNT1": "Natural Tree 1",
    "TNT2": "Natural Tree 2",
    "TNT3": "Natural Tree 3",
    "TNT4": "Natural Tree 4",
    "TOH1": "Ash Tree with Nymphs",
    "TOH2": "Ohio Tree 2",
    "TOH3": "Ohio Tree 3",
    "TOT1": "Abstract Tree 1",
    "TOT2": "Abstract Tree 2",
    "TOT3": "Abstract Tree 3",
    "TOT4": "Abstract Tree 4",
    "TR1": "Regular Tree 1",
    "TR2": "Regular Tree 2",
    "TRF3": "Rainforest Tree",
    "TST1": "Stump Tree 1",
    "TST2": "Stump Tree 2",
    "TST3": "Stump Tree 3",
    "TST4": "Stump Tree 4",
    "TST5": "Stump Tree 5",
    "TT1": "Tall Tree",
    "TWH1": "Weeping Willow 1",
    "TWH2": "Weeping Willow 2",

    # Australian Theme
    "TAS1": "Australian Tree 1",
    "TAS2": "Australian Tree 2",
    "TAS3": "Australian Tree 3",
    "TAS4": "Australian Tree 4",
    "1X1ATREE": "Boab Tree",
    "1X1ATRE2": "Australian Tree",
    "3X3ATRE1": "Large Australian Tree 1",
    "3X3ATRE2": "Large Australian Tree 2",
    "3X3ATRE3": "Large Australian Tree 3",
    "3X3EUCAL": "Eucalyptus Tree",
    "3X3MANTR": "Mangrove Tree",

    # Special Trees
    "MAJOROAK": "Large Oak",
    "YEWTREEX": "Yew Tree",
    "BAMBOOPL": "Bamboo",

    # Shrubs (tree-like)
    "TSH0": "Shrub 1",
    "TSH1": "Shrub 2",
    "TSH2": "Shrub 3",
    "TSH3": "Shrub 4",
    "TSH4": "Shrub 5",
    "TSH5": "Shrub 6",
    "TSP1": "Spruce 1",
    "TSP2": "Spruce 2",
}


def find_dat_file(code: str) -> Path | None:
    """Find the DAT file for a given object code."""
    # Try exact match first (with padding)
    for padding in ["", " ", "  ", "   ", "    "]:
        padded = code + padding
        dat_file = RCT2_OBJDATA / f"{padded}.DAT"
        if dat_file.exists():
            return dat_file

    # Try case-insensitive search
    code_upper = code.upper()
    for f in RCT2_OBJDATA.iterdir():
        if f.name.upper().startswith(code_upper) and f.suffix.upper() == ".DAT":
            return f

    return None


def decode_rct_string(data: bytes) -> str:
    """
    Decode an RCT2 string, handling the special encoding.

    RCT2 uses 0xFF as an escape character. When 0xFF is encountered,
    the next two bytes form a 16-bit code point (big-endian).
    """
    result = []
    i = 0
    while i < len(data):
        b = data[i]
        if b == 0:
            break
        # RCT2 uses 0xFF as escape for two-byte characters
        if b == 0xFF and i + 2 < len(data):
            # Next two bytes form a 16-bit character code
            high = data[i + 1]
            low = data[i + 2]
            code = (high << 8) | low

            # Map special RCT2 codes to unicode
            if code < 256:
                result.append(chr(code))
            else:
                # Some codes are special symbols, just use the low byte
                result.append(chr(low))
            i += 3
            continue
        # Normal printable ASCII
        if 32 <= b < 127:
            result.append(chr(b))
        elif b >= 128:
            # Windows-1252 extended ASCII
            try:
                result.append(bytes([b]).decode("cp1252"))
            except:
                pass
        i += 1
    return "".join(result)


def extract_object_name(dat_path: Path) -> str:
    """Extract the English object name from a DAT file."""
    try:
        with open(dat_path, "rb") as f:
            data = f.read()

        # The string table starts after the header and object data
        # Skip the 16-byte RCTObjectEntry header and object-specific data
        # Small scenery string table starts at offset 0x1C (28 bytes)
        offset = 0x1C

        # Find the first null-terminated ASCII string that looks like a name
        # The format is: language_code (1 byte) + string + null
        while offset < len(data) - 1 and offset < 200:
            lang_code = data[offset]

            # Language code 0x00 = English (British)
            # Language code 0x01 = English (American)
            if lang_code in (0x00, 0x01):
                # Extract the string bytes
                str_start = offset + 1
                str_end = str_start
                while str_end < len(data) and data[str_end] != 0:
                    str_end += 1

                if str_end > str_start:
                    raw_bytes = data[str_start:str_end]
                    # Skip if starts with 0xFF (control code)
                    if raw_bytes[0] == 0xFF:
                        offset += 1
                        continue
                    name = decode_rct_string(raw_bytes)
                    if len(name) >= 3:
                        return name

            offset += 1

        # Fallback: just use the DAT filename
        return dat_path.stem

    except Exception as e:
        print(f"  Warning: Could not extract name from {dat_path}: {e}")
        return dat_path.stem


def sanitize_filename(name: str) -> str:
    """Convert an object name to a safe filename."""
    # Replace problematic characters
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

        # Check if any PNGs were created
        pngs = list(output_path.glob("*.png"))
        if pngs:
            return True
        else:
            # Clean up empty directory
            output_path.rmdir()
            return False

    except subprocess.TimeoutExpired:
        print(f"  Timeout exporting {dat_path.name}")
        return False
    except Exception as e:
        print(f"  Error exporting {dat_path.name}: {e}")
        return False


def main():
    print("RCT2 Tree Sprite Extractor")
    print("=" * 50)

    if not RCT2_OBJDATA.exists():
        print(f"Error: RCT2 ObjData directory not found at {RCT2_OBJDATA}")
        sys.exit(1)

    if not OPENRCT2_BIN.exists():
        print(f"Error: OpenRCT2 binary not found at {OPENRCT2_BIN}")
        print("Make sure you've built OpenRCT2 first.")
        sys.exit(1)

    # Create output directory
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    success_count = 0
    fail_count = 0
    not_found = []

    print(f"\nProcessing {len(TREE_NAMES)} tree objects")
    print(f"Output directory: {OUTPUT_DIR}\n")

    for code, name in sorted(TREE_NAMES.items()):
        dat_path = find_dat_file(code)
        if not dat_path:
            not_found.append(code)
            continue

        print(f"Processing {code}: {name}")

        if export_sprites(dat_path, name):
            success_count += 1
            print(f"  -> Exported to: {sanitize_filename(name)}/")
        else:
            fail_count += 1
            print(f"  -> No sprites exported")

    print("\n" + "=" * 50)
    print(f"Done! Exported {success_count} trees, {fail_count} failed/empty")
    if not_found:
        print(f"Not found: {', '.join(not_found)}")
    print(f"Output: {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
