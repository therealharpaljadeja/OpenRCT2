/*****************************************************************************
 * Copyright (c) 2014-2025 OpenRCT2 developers
 *
 * For a complete list of all authors, please refer to contributors.md
 * Interested in contributing? Visit https://github.com/OpenRCT2/OpenRCT2
 *
 * OpenRCT2 is licensed under the GNU General Public License version 3.
 *****************************************************************************/

#include <algorithm>
#include <array>
#include <cctype>
#include <cstring>
#include <cmath>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <unordered_map>
#include <limits>
#include <vector>

#include <SDL.h>
#include <SDL_clipboard.h>
#include <SDL_keycode.h>

#include <openrct2/Input.h>
#include <openrct2/Context.h>
#include <openrct2/Diagnostic.h>
#include <openrct2/core/UTF8.h>
#include <openrct2/core/File.h>
#include <openrct2/core/Path.hpp>
#include <openrct2/SpriteIds.h>
#include <openrct2/drawing/Drawing.String.h>
#include <openrct2/drawing/Drawing.h>
#include <openrct2/drawing/IDrawingContext.h>
#include <openrct2/drawing/IDrawingEngine.h>
#include <openrct2/drawing/Font.h>
#include <openrct2/drawing/Rectangle.h>
#include <openrct2/drawing/Text.h>
#include <openrct2/drawing/TTF.h>
#include <openrct2/drawing/ColourPalette.h>
#include <openrct2/config/Config.h>
#include <openrct2/aiagent/AIAgentFollowApi.h>
#include <openrct2/aiagent/AIAgentPromptBridge.h>
#include <openrct2/PlatformEnvironment.h>
#include <openrct2/interface/Colour.h>
#include <openrct2/interface/Widget.h>
#include <openrct2/ui/UiContext.h>
#include <openrct2/ui/WindowManager.h>
#include <openrct2/terminal/AIAgentLaunch.h>
#include <openrct2/terminal/SessionFileMonitor.h>
#include <openrct2/terminal/SessionLogGenerator.h>
#include <openrct2/terminal/ShellProcess.h>
#include <openrct2/terminal/TerminalSession.h>
#include <openrct2/GameState.h>

#include <openrct2-ui/UiStringIds.h>
#include <openrct2-ui/input/InputManager.h>
#include <openrct2-ui/interface/Widget.h>
#include <openrct2-ui/interface/Window.h>
#include <openrct2-ui/windows/Windows.h>
#include <openrct2/interface/Colour.h>
#include <openrct2/interface/Window.h>

using OpenRCT2::TextInputSession;
using OpenRCT2::Terminal::AIAgentLaunchPlan;
using OpenRCT2::Terminal::ShellLaunchOptions;
using OpenRCT2::Terminal::ShellProcess;
using OpenRCT2::Terminal::TerminalCell;
using OpenRCT2::Terminal::TerminalSession;
using OpenRCT2::Terminal::TerminalSnapshot;
using OpenRCT2::Terminal::BuildAIAgentLaunchPlan;
using OpenRCT2::Terminal::SessionLogGenerator;
using OpenRCT2::Ui::InputEvent;
namespace Rect = OpenRCT2::Drawing::Rectangle;

#ifndef TTF_GlyphIsProvided32
    #define TTF_GlyphIsProvided32 TTF_GlyphIsProvided
#endif

namespace
{
#if OPENRCT2_HAVE_LIBVTERM
    constexpr bool kLibVTermAvailable = true;
#else
    constexpr bool kLibVTermAvailable = false;
#endif

    std::optional<char> MapPrintableKey(const InputEvent& e)
    {
        const bool shift = (e.modifiers & KMOD_SHIFT) != 0;

        if (e.button >= SDLK_a && e.button <= SDLK_z)
        {
            char base = static_cast<char>('a' + (e.button - SDLK_a));
            if (shift)
            {
                base = static_cast<char>(std::toupper(static_cast<unsigned char>(base)));
            }
            return base;
        }

        if (e.button >= SDLK_0 && e.button <= SDLK_9)
        {
            static constexpr const char* kShiftedNums = ")!@#$%^&*(";
            const int idx = e.button - SDLK_0;
            return shift ? kShiftedNums[idx] : static_cast<char>('0' + idx);
        }

        switch (e.button)
        {
            case SDLK_SPACE:
                return ' ';
            case SDLK_MINUS:
                return shift ? '_' : '-';
            case SDLK_EQUALS:
                return shift ? '+' : '=';
            case SDLK_LEFTBRACKET:
                return shift ? '{' : '[';
            case SDLK_RIGHTBRACKET:
                return shift ? '}' : ']';
            case SDLK_BACKSLASH:
                return shift ? '|' : '\\';
            case SDLK_SEMICOLON:
                return shift ? ':' : ';';
            case SDLK_QUOTE:
                return shift ? '"' : '\'';
            case SDLK_BACKQUOTE:
                return shift ? '~' : '`';
            case SDLK_COMMA:
                return shift ? '<' : ',';
            case SDLK_PERIOD:
                return shift ? '>' : '.';
            case SDLK_SLASH:
                return shift ? '?' : '/';
            case SDLK_KP_MINUS:
                return '-';
            case SDLK_KP_PLUS:
                return '+';
            case SDLK_KP_MULTIPLY:
                return '*';
            case SDLK_KP_DIVIDE:
                return '/';
            case SDLK_KP_PERIOD:
                return '.';
            case SDLK_KP_COMMA:
                return '.';
            case SDLK_KP_0:
            case SDLK_KP_1:
            case SDLK_KP_2:
            case SDLK_KP_3:
            case SDLK_KP_4:
            case SDLK_KP_5:
            case SDLK_KP_6:
            case SDLK_KP_7:
            case SDLK_KP_8:
            case SDLK_KP_9:
                return static_cast<char>('0' + (e.button - SDLK_KP_0));
            default:
                break;
        }

        return std::nullopt;
    }

    std::string GetClipboardText()
    {
        char* raw = SDL_GetClipboardText();
        if (raw == nullptr)
        {
            return {};
        }

        std::string text(raw);
        SDL_free(raw);

        if (text.empty())
        {
            return {};
        }

        std::string normalised;
        normalised.reserve(text.size());
        for (size_t i = 0; i < text.size(); ++i)
        {
            char c = text[i];
            if (c == '\r')
            {
                if (i + 1 < text.size() && text[i + 1] == '\n')
                {
                    continue;
                }
                normalised.push_back('\n');
            }
            else
            {
                normalised.push_back(c);
            }
        }

        return normalised;
    }

    class TerminalPaletteMapper
    {
    public:
        static TerminalPaletteMapper& Instance()
        {
            static TerminalPaletteMapper instance;
            return instance;
        }

        uint8_t Map(const OpenRCT2::Terminal::TerminalColourRGB& colour)
        {
            // Special-case: terminal default black (0,0,0) should match canvas background
            // to prevent flickering from color mismatch during redraws. The canvas uses
            // ColourMapA[COLOUR_BLACK].mid_dark, so cells with black backgrounds should too.
            if (colour.r == 0 && colour.g == 0 && colour.b == 0)
            {
                return ColourMapA[COLOUR_BLACK].mid_dark;
            }

            const uint32_t key = (static_cast<uint32_t>(colour.r) << 16) | (static_cast<uint32_t>(colour.g) << 8)
                | colour.b;
            if (auto it = _cache.find(key); it != _cache.end())
            {
                return it->second;
            }

            const auto& palette = gPalette;
            uint32_t bestScore = std::numeric_limits<uint32_t>::max();
            uint8_t bestIndex = ColourMapA[COLOUR_BLACK].mid_dark;
            for (uint32_t i = 0; i < OpenRCT2::Drawing::kGamePaletteSize; i++)
            {
                if (!IsStableIndex(i))
                {
                    continue;
                }

                const auto& entry = palette[i];
                const int32_t dr = static_cast<int32_t>(colour.r) - entry.Red;
                const int32_t dg = static_cast<int32_t>(colour.g) - entry.Green;
                const int32_t db = static_cast<int32_t>(colour.b) - entry.Blue;
                const uint32_t score = static_cast<uint32_t>(dr * dr + dg * dg + db * db);
                if (score < bestScore)
                {
                    bestScore = score;
                    bestIndex = static_cast<uint8_t>(i);
                }
            }

            _cache.emplace(key, bestIndex);
            return bestIndex;
        }

    private:
        static constexpr bool IsStableIndex(uint32_t index)
        {
            if (index == static_cast<uint32_t>(PaletteIndex::pi0))
            {
                return false;
            }
            if (IsWithinRange(index, kPaletteOffsetRemapPrimary, kPaletteLengthRemap))
            {
                return false;
            }
            if (IsWithinRange(index, kPaletteOffsetRemapSecondary, kPaletteLengthRemap))
            {
                return false;
            }
            if (IsWithinRange(index, kPaletteOffsetRemapTertiary, kPaletteLengthRemap))
            {
                return false;
            }
            if (IsWithinRange(index, kPaletteOffsetAnimated, kPaletteLengthAnimated))
            {
                return false;
            }
            return true;
        }

        static constexpr bool IsWithinRange(uint32_t index, PaletteIndex start, uint8_t length)
        {
            const auto begin = static_cast<uint32_t>(start);
            const auto end = begin + length;
            return index >= begin && index < end;
        }

        std::unordered_map<uint32_t, uint8_t> _cache;
    };

#ifndef DISABLE_TTF
    class TerminalFontPipeline
    {
    public:
        static TerminalFontPipeline& Instance()
        {
            static TerminalFontPipeline instance;
            return instance;
        }

        void EnsureLoaded()
        {
            if (_initialised)
            {
                return;
            }
            _initialised = true;

            if (_primaryFont != nullptr)
            {
                _ready = true;
                return;
            }

            if (!_EnsureTTFInit())
            {
                return;
            }

            auto* context = OpenRCT2::GetContext();
            if (context == nullptr)
            {
                return;
            }

            auto& env = context->GetPlatformEnvironment();
            auto fontsDir = env.GetDirectoryPath(OpenRCT2::DirBase::openrct2);
            fontsDir = OpenRCT2::Path::Combine(fontsDir, u8"data");
            fontsDir = OpenRCT2::Path::Combine(fontsDir, u8"fonts");

            struct FontSpec
            {
                const char* filename;
                const char* label;
                bool preferred;
            };

            static constexpr std::array<FontSpec, 3> kFontSpecs{ {
                { "JetBrainsMono-Regular.ttf", "JetBrains Mono", true },
                { "NotoSansSymbols-Regular.ttf", "Noto Sans Symbols", false },
                { "NotoSansSymbols2-Regular.ttf", "Noto Sans Symbols 2", false },
            } };
            // 11pt — compact variant; cells stay legible while the window footprint shrinks
            // ~20% vs the old 14pt. Window default + minimum below scales accordingly so the
            // visible column count is preserved.
            static constexpr int32_t kTerminalFontPointSize = 11;

            auto LoadFont = [&](const FontSpec& spec) -> TTF_Font* {
                u8string filename;
                const size_t len = std::strlen(spec.filename);
                filename.reserve(len);
                filename.append(spec.filename, spec.filename + len);

                auto path = OpenRCT2::Path::Combine(fontsDir, filename);
                const std::string fontPathUtf8(path.begin(), path.end());
                if (!OpenRCT2::File::Exists(fontPathUtf8))
                {
                    LOG_WARNING("AIAgentTerminal: Font %s not found at %s", spec.label, fontPathUtf8.c_str());
                    return nullptr;
                }

                auto* font = TTF_OpenFont(fontPathUtf8.c_str(), kTerminalFontPointSize);
                if (font == nullptr)
                {
                    LOG_WARNING("AIAgentTerminal: TTF_OpenFont failed for %s", fontPathUtf8.c_str());
                    return nullptr;
                }
                TTF_SetFontHinting(font, 1);
                return font;
            };

            auto ApplyMetrics = [&](TTF_Font* font) {
                int glyphWidth = 0;
                int glyphHeight = 0;
                if (TTF_SizeUTF8(font, "W", &glyphWidth, &glyphHeight) != 0 || glyphWidth <= 0 || glyphHeight <= 0)
                {
                    glyphWidth = 10;
                    glyphHeight = 16;
                }

                _cellWidth = std::max(6, glyphWidth);
                _glyphHeight = glyphHeight;
                _cellHeight = glyphHeight + 2;

                if (std::getenv("OPENRCT2_AGENT_TTY_DEBUG") != nullptr)
                {
                    LOG_INFO("AIAgentTerminal: Font metrics at %dpt: cellWidth=%d, glyphHeight=%d, cellHeight=%d",
                             kTerminalFontPointSize, _cellWidth, _glyphHeight, _cellHeight);
                }
            };

            for (const auto& spec : kFontSpecs)
            {
                if (TTF_Font* font = LoadFont(spec))
                {
                    _fonts.push_back(FontEntry{ font, spec.label });
                    if (_primaryFont == nullptr && (spec.preferred || _fonts.size() == 1))
                    {
                        _primaryFont = font;
                        ApplyMetrics(font);
                    }
                }
            }

            if (_primaryFont == nullptr && !_fonts.empty())
            {
                _primaryFont = _fonts.front().handle;
                ApplyMetrics(_primaryFont);
            }

            _fontLookup.clear();
            _hintingThreshold = 60;
            _ready = (_primaryFont != nullptr);
        }

        bool IsReady() const
        {
            return _ready && _primaryFont != nullptr;
        }

        TTF_Font* GetFont() const
        {
            return _primaryFont;
        }

        TTF_Font* GetFontForCodepoint(char32_t codepoint) const
        {
            if (_fonts.empty())
            {
                return nullptr;
            }

            if (codepoint <= 0)
            {
                return _primaryFont;
            }

            const auto cached = _fontLookup.find(codepoint);
            if (cached != _fontLookup.end())
            {
                return _fonts[cached->second].handle;
            }

            const uint32_t glyph = static_cast<uint32_t>(codepoint);
            for (size_t i = 0; i < _fonts.size(); i++)
            {
                if (TTF_GlyphIsProvided32(_fonts[i].handle, glyph) != 0)
                {
                    _fontLookup.emplace(codepoint, i);
                    return _fonts[i].handle;
                }
            }

            _fontLookup.emplace(codepoint, 0);
            return _primaryFont;
        }

        int32_t GetCellWidth() const
        {
            return _cellWidth;
        }

        int32_t GetCellHeight() const
        {
            return _cellHeight;
        }

        int32_t GetGlyphHeight() const
        {
            return _glyphHeight;
        }

        uint8_t GetHintingThreshold() const
        {
            return _hintingThreshold;
        }

    private:
        TerminalFontPipeline() = default;
        ~TerminalFontPipeline()
        {
            for (auto& entry : _fonts)
            {
                if (entry.handle != nullptr)
                {
                    TTF_CloseFont(entry.handle);
                }
            }
            _fonts.clear();
            _primaryFont = nullptr;
        }

        static bool _EnsureTTFInit()
        {
            static bool sTTFInitialised = false;
            static bool sAttempted = false;
            if (sAttempted)
            {
                return sTTFInitialised;
            }
            sAttempted = true;
            sTTFInitialised = (TTF_Init() == 0);
            if (!sTTFInitialised)
            {
                LOG_WARNING("AIAgentTerminal: TTF_Init failed");
            }
            return sTTFInitialised;
        }

        bool _initialised = false;
        bool _ready = false;
        struct FontEntry
        {
            TTF_Font* handle = nullptr;
            std::string label;
        };

        TTF_Font* _primaryFont = nullptr;
        std::vector<FontEntry> _fonts;
        mutable std::unordered_map<char32_t, size_t> _fontLookup;
        int32_t _cellWidth = 8;
        int32_t _cellHeight = 14;
        int32_t _glyphHeight = 12;
        uint8_t _hintingThreshold = 0;
    };
#endif // DISABLE_TTF

    TerminalCell MakeBlankTerminalCell()
    {
        TerminalCell cell{};
        cell.codepoint = U' ';
        cell.foreground = COLOUR_WHITE;
        cell.background = COLOUR_BLACK;
        cell.foregroundRgb = { 255, 255, 255 };
        cell.backgroundRgb = { 0, 0, 0 };
        return cell;
    }

    bool CellsEqual(const TerminalCell& a, const TerminalCell& b)
    {
        return a.codepoint == b.codepoint
            && a.foreground == b.foreground
            && a.background == b.background
            && a.foregroundRgb.r == b.foregroundRgb.r
            && a.foregroundRgb.g == b.foregroundRgb.g
            && a.foregroundRgb.b == b.foregroundRgb.b
            && a.backgroundRgb.r == b.backgroundRgb.r
            && a.backgroundRgb.g == b.backgroundRgb.g
            && a.backgroundRgb.b == b.backgroundRgb.b
            && a.bold == b.bold
            && a.underline == b.underline
            && a.inverse == b.inverse
            && a.wide == b.wide
            && a.continuation == b.continuation;
    }
} // namespace

namespace OpenRCT2::Ui::Windows
{
    enum AIAgentTerminalWidgetIdx
    {
        WIDX_BACKGROUND,
        WIDX_TITLE,
        WIDX_CLOSE,
        WIDX_SIDEBAR,
        WIDX_FOLLOW_BUTTON,
        WIDX_MINIMIZE_BUTTON,
        WIDX_AUTOPLAY_BUTTON,
        WIDX_SCROLL_LOCK_BUTTON,
        WIDX_TERMINAL_CANVAS,
        WIDX_PROMPT_QUEUE,
        WIDX_HIDDEN_TEXTBOX,
    };

    // Initial + minimum window size. Sized to roughly preserve the column count of the
    // pre-shrink default (672×544 at 14pt) at the new 11pt font — cells are ~20% smaller,
    // so the window can be ~20% smaller without losing visible columns.
    constexpr ScreenSize kAgentWindowSize = { 480, 400 };
    constexpr ScreenSize kAgentWindowMaxSize = { 1600, 1200 };
    constexpr int32_t kTerminalPadding = 4;
    constexpr int32_t kSidebarWidth = 40;
    constexpr int32_t kSidebarGap = 6;
    constexpr int32_t kSidebarButtonSize = 24;
    constexpr int32_t kSidebarButtonTopPadding = 6;
    constexpr int32_t kSidebarButtonSpacing = 6;
    constexpr int16_t kSidebarShellWidth = static_cast<int16_t>(kSidebarWidth + 8);
    constexpr ScreenSize kAgentWindowCollapsedMinSize = { kSidebarShellWidth, kAgentWindowSize.height };
    constexpr ScreenSize kAgentWindowCollapsedMaxSize = { kSidebarShellWidth, kAgentWindowMaxSize.height };
    constexpr size_t kPtyBufferSize = 8192;
    constexpr int32_t kTextInputWatchdogFrames = 180;
    constexpr int32_t kPromptQueuePanelHeight = 80;
    constexpr int32_t kPromptQueueVisibleCount = 3;
    constexpr int32_t kPromptQueueRowHeight = 20;
    constexpr int32_t kPromptQueuePadding = 8;

    static constexpr auto kAIAgentTerminalWidgets = makeWidgets(
        makeWindowShim(STR_AGENT_TERMINAL_TITLE, kAgentWindowSize),
        makeWidget(
            { static_cast<int16_t>(kAgentWindowSize.width - 36), static_cast<int16_t>(kTitleHeightNormal + 4) },
            { 32, static_cast<int16_t>(kAgentWindowSize.height - kTitleHeightNormal - 8) },
            WidgetType::custom,
            WindowColour::secondary),
        makeWidget(
            { 4, static_cast<int16_t>(kTitleHeightNormal + 4) },
            { 24, 20 },
            WidgetType::flatBtn,
            WindowColour::secondary,
            ImageId(SPR_LOCATE),
            STR_AGENT_FOLLOW_BUTTON_TIP),
        makeWidget(
            { 4, static_cast<int16_t>(kTitleHeightNormal + 32) },
            { 24, 20 },
            WidgetType::flatBtn,
            WindowColour::secondary,
            ImageId(SPR_NEXT),
            STR_AGENT_MINIMIZE_BUTTON_TIP),
        makeWidget(
            { 4, static_cast<int16_t>(kTitleHeightNormal + 60) },
            { 24, 24 },
            WidgetType::flatBtn,
            WindowColour::secondary,
            ImageId(),
            STR_AGENT_AUTOPLAY_BUTTON_TIP),
        makeWidget(
            { 4, static_cast<int16_t>(kTitleHeightNormal + 88) },
            { 24, 24 },
            WidgetType::flatBtn,
            WindowColour::secondary,
            ImageId(SPR_G2_ARROW_DOWN),
            STR_AGENT_SCROLL_LOCK_BUTTON_TIP),
        makeWidget(
            { 4, static_cast<int16_t>(kTitleHeightNormal + 4) },
            { kAgentWindowSize.width - 8, static_cast<int16_t>(kAgentWindowSize.height - kTitleHeightNormal - 8) },
            WidgetType::custom, WindowColour::secondary),
        makeWidget(
            { 4, static_cast<int16_t>(kAgentWindowSize.height - 4) },
            { kAgentWindowSize.width - 8, kPromptQueuePanelHeight },
            WidgetType::custom, WindowColour::secondary),
        makeWidget({ 2, 2 }, { 2, 2 }, WidgetType::textBox, WindowColour::secondary));

    // Helper to position sidebar buttons in a vertical strip
    static void PositionSidebarButton(Widget& button, int16_t sidebarLeft, int16_t sidebarTop, int32_t buttonIndex)
    {
        const int16_t buttonLeft = static_cast<int16_t>(sidebarLeft + (kSidebarWidth - kSidebarButtonSize) / 2);
        const int16_t buttonTop = static_cast<int16_t>(
            sidebarTop + kSidebarButtonTopPadding + buttonIndex * (kSidebarButtonSize + kSidebarButtonSpacing));
        button.left = buttonLeft;
        button.right = static_cast<int16_t>(buttonLeft + kSidebarButtonSize);
        button.top = buttonTop;
        button.bottom = static_cast<int16_t>(buttonTop + kSidebarButtonSize);
    }

    struct TerminalGeometry
    {
        int32_t cols;
        int32_t rows;
        int32_t widthPx;
        int32_t heightPx;
    };

    class AIAgentTerminalWindow final : public Window
    {
    public:
        AIAgentTerminalWindow();

        void onOpen() override;
        void onClose() override;
        void onPrepareDraw() override;
        void onDraw(RenderTarget& rt) override;
        void onDrawWidget(WidgetIndex widgetIndex, RenderTarget& rt) override;
        void onMouseDown(WidgetIndex widgetIndex) override;
        void onMouseUp(WidgetIndex widgetIndex) override;
        void onTextInput(WidgetIndex widgetIndex, std::string_view text) override;
        void onUpdate() override;
        void onResize() override;

        bool HandleKeyboardEvent(const InputEvent& e);
        bool WantsKeyboardCapture() const;
        bool onMouseWheel(WidgetIndex widgetIndex, int32_t wheel) override;

    private:
        void SetCollapsed(bool collapsed);
        void ApplySizeConstraints();
        static constexpr int16_t GetCollapsedWidth()
        {
            return kSidebarShellWidth;
        }

        std::unique_ptr<TerminalSession> _terminalSession;
        std::unique_ptr<ShellProcess> _shellProcess;
        TerminalSnapshot _snapshot;
        TerminalSnapshot _pendingSnapshot;
        AIAgentLaunchPlan _launchPlan;
        bool _hasSnapshot = false;
        bool _hasPendingSnapshot = false;
        bool _launchAttempted = false;
        bool _textCaptureActive = false;
        bool _lastProcessRunning = false;
        bool _needsFullRedraw = true;
        uint64_t _lastOutputTimestamp = 0;
        int32_t _cellWidth = 8;
        int32_t _cellHeight = 14;
        int32_t _visibleCols = 80;
        int32_t _visibleRows = 24;
        int32_t _scrollHeadRow = 0;
        bool _isCollapsed = false;
        bool _textInputWorking = false;
        int32_t _textInputIdleFrames = 0;
        uint64_t _lastPasteModifierTick = 0;
        bool _pendingPasteFallback = false; // Tracks Flow-style Cmd+V sequences that drop modifiers early
        mutable std::vector<Terminal::TerminalCell> _rowScratch;
        std::string _statusMessage;
        int32_t _statusMessageTimeout = 0; // Frames until status message clears (0 = permanent)
        static constexpr int32_t kStatusMessageTimeoutFrames = 120; // 3 seconds at 40 fps
        std::string _errorMessage;
        std::array<uint8_t, kPtyBufferSize> _ptyReadBuffer{};
        std::vector<uint8_t> _ptyDrainBuffer;
        FontStyle _fontStyle = FontStyle::medium;
        bool _terminalFontReady = false;
        uint8_t _terminalHintingThreshold = 0;
        int32_t _terminalGlyphHeight = 0;
        int16_t _restoreWidth = kAgentWindowSize.width;
        std::vector<std::string> _rendererWarnings;
        double _pendingWheelPx = 0.0;
        std::vector<TerminalCell> _renderedCells;
        int32_t _renderedCols = 0;
        int32_t _renderedRows = 0;
        bool _lastOverlayVisible = false;
        int32_t _lastOverlayHeightPx = 0;
        mutable std::vector<uint8_t> _dirtyMaskScratch;
        bool _altScreenActive = false;
        bool _hasSeenOutput = false;

        // Auto-play mode state
        bool _autoplayEnabled = false;
        // Scroll lock mode - disables scroll-up for streaming
        bool _scrollLockEnabled = false;
        bool _autoFollowEnabled = true;
        uint16_t _animationFrame = 0;
        uint16_t _lastRenderFrame = 0;
        uint64_t _lastRenderTickMs = 0;
        uint64_t _lastOutputTickMs = 0;
        static constexpr uint16_t kTerminalRefreshInterval = 1; // Refresh every frame when output is stable
        static constexpr uint64_t kTerminalQuietWindowMs = 24; // Wait for output to settle before rendering
        static constexpr uint64_t kTerminalQuietWindowMsFollow = 12; // Snappier follow mode
        static constexpr uint64_t kTerminalQuietWindowMsLock = 48; // Calmer lock mode to reduce motion
        static constexpr uint64_t kTerminalMaxRenderLatencyMs = 80; // Render at least this often during bursts
        static constexpr uint64_t kTerminalMaxRenderLatencyMsFollow = 50; // Snappier follow mode
        static constexpr uint64_t kTerminalMaxRenderLatencyMsLock = 140; // Calmer lock mode to batch bursts
        static constexpr uint16_t kTerminalRefreshIntervalLock = 2; // Lower FPS in lock mode
        static constexpr uint64_t kTerminalDecSyncMaxHoldMs = 250; // Allow periodic renders if sync is held open
        enum class DecSyncParseState
        {
            Normal,
            Esc,
            Csi,
        };
        DecSyncParseState _decSyncState = DecSyncParseState::Normal;
        bool _decSyncPrivate = false;
        bool _decSyncHas2026 = false;
        int32_t _decSyncParam = -1;
        int32_t _decSyncDepth = 0;
        bool _decSyncJustEnded = false;
        uint64_t _decSyncStartTickMs = 0;

        // Double buffering: draw terminal to offscreen buffer first, then blit to screen
        // This eliminates flickering by presenting the complete frame in one operation
        std::unique_ptr<uint8_t[]> _offscreenBuffer;
        int32_t _offscreenWidth = 0;
        int32_t _offscreenHeight = 0;
        std::vector<std::string> _autoplayPrompts;
        size_t _autoplayPromptIndex = 0;
        // Session file-based turn detection (monitors ~/.claude/projects/ JSONL files)
        std::unique_ptr<OpenRCT2::Terminal::SessionFileMonitor> _sessionMonitor;
        bool _autoplayWaitingForResponse = false;
        int32_t _autoplayDelayFrames = 0;
        static constexpr int32_t kAutoplayDelayAfterResponse = 1200; // 30 seconds at 40 ticks/sec (game tick rate)
        // Deferred Enter key - send CR on the next frame after sending text
        bool _autoplayPendingEnter = false;
        int32_t _autoplayEnterDelayFrames = 0;
        // Throttle session monitor polling (counts frames between polls)
        int32_t _sessionMonitorPollCounter = 0;

        // Session logging state
        std::filesystem::path _workspacePath;
        std::string _inputBuffer;  // Buffer to detect /clear command

        void LaunchProcess();
        void AcquireKeyboardFocus();
        void ReleaseKeyboardFocus();
        void EnsureKeyboardFocusIntegrity();
        bool HasKeyboardFocus() const;
        void PollProcess();
        void UpdateCanvasWidgetBounds();
        void UpdateGeometry();
        TerminalGeometry CalculateGeometry() const;
        void DrawTerminalDoubleBuffered(RenderTarget& screenRT, const Widget& widget);
        void DrawTerminalToBuffer(RenderTarget& rt, int32_t canvasWidth, int32_t canvasHeight, const std::vector<std::string>& lines) const;
        void DrawTerminalDirty(RenderTarget& rt, int32_t canvasWidth, int32_t canvasHeight,
            const std::vector<TerminalCell>& cells, const std::vector<std::string>& lines);
        void EnsureOffscreenBuffer(int32_t width, int32_t height);
        void BlitOffscreenToScreen(RenderTarget& screenRT, const ScreenCoordsXY& destPos, int32_t width, int32_t height);
        void DrawCells(RenderTarget& rt, const ScreenCoordsXY& origin, int32_t canvasWidth, int32_t canvasHeight) const;
        void DrawRowCells(RenderTarget& rt, const ScreenCoordsXY& rowOrigin, std::span<const TerminalCell> row) const;
        void DrawCellAt(RenderTarget& rt, const ScreenCoordsXY& rowOrigin, int32_t col, const TerminalCell& cell) const;
        void DrawStatusOverlay(RenderTarget& rt, const ScreenCoordsXY& origin, int32_t canvasWidth, int32_t canvasHeight,
            const std::vector<std::string>& lines) const;
        void UpdateSynchronizedUpdateState(std::span<const uint8_t> bytes);
        void DrawSidebar(RenderTarget& rt, const Widget& widget) const;
        void ClearTextInputBuffer() const;
        void RefreshSnapshotIfNeeded();
        void EnsureSession();
        void EnsureTerminalFont();
        void UpdateRendererWarnings();
        void DrawCellGlyph(RenderTarget& rt, const ScreenCoordsXY& cellPos, int32_t cellWidthPx, const TerminalCell& cell) const;
        int32_t GetCellPixelWidth(const TerminalCell& cell) const;
        std::vector<std::string> BuildStatusLines(const std::string& primaryMessage) const;
        std::vector<std::string> CollectStatusLines() const;
        void BuildVisibleCells(std::vector<TerminalCell>& out) const;
        std::string BuildKeySequence(const InputEvent& e) const;
        void ScrollByRows(int deltaRows);
        void ClampScrollHead();
        void SnapScrollToTail();
        void EnforceScrollLock();
        int32_t GetScrollbackRowCount() const;
        int32_t GetTotalRowCount() const;
        void CopyRowIntoBuffer(int rowIndex, std::vector<TerminalCell>& out) const;
        bool TryHandleClipboardPasteFallback(const InputEvent& e);
        void ResumeAutoFollow();
        static bool IsPrintableAscii(char ch);
        void LoadAutoplayPrompts();
        void SendNextAutoplayPrompt();
        void ToggleAutoplay();
        void SetViewportLock(bool enabled);
        void InitializeSessionMonitor();
        void UpdatePromptQueueBounds();
        void DrawPromptQueue(RenderTarget& rt);
        void GenerateSessionLog();
        void CheckForClearCommand(std::string_view text);
    };

    static AIAgentTerminalWindow* sAIAgentTerminalInstance = nullptr;

    AIAgentTerminalWindow::AIAgentTerminalWindow()
    {
        _cellHeight = FontGetLineHeight(_fontStyle) + 2;
        _cellWidth = FontSpriteGetCodepointWidth(_fontStyle, 'W');
        if (_cellWidth <= 0)
        {
            _cellWidth = 8;
        }
        constexpr float kCellWidthScale = 0.65f;
        _cellWidth = std::max<int32_t>(static_cast<int32_t>(std::lround(_cellWidth * kCellWidthScale)), 5);
        _ptyDrainBuffer.reserve(kPtyBufferSize * 4);
        EnsureTerminalFont();
    }

    void AIAgentTerminalWindow::onOpen()
    {
        sAIAgentTerminalInstance = this;
        setWidgets(kAIAgentTerminalWidgets);
        widgets[WIDX_HIDDEN_TEXTBOX].flags.set(WidgetFlag::isHidden, true);
        widgets[WIDX_PROMPT_QUEUE].flags.set(WidgetFlag::isHidden, true);
        widgets[WIDX_FOLLOW_BUTTON].flags.set(WidgetFlag::isHoldable, true);
        widgets[WIDX_MINIMIZE_BUTTON].flags.set(WidgetFlag::isHoldable, true);
        widgets[WIDX_AUTOPLAY_BUTTON].flags.set(WidgetFlag::isHoldable, true);
        widgets[WIDX_SCROLL_LOCK_BUTTON].flags.set(WidgetFlag::isHoldable, true);
        ApplySizeConstraints();
        UpdateGeometry();
        EnsureTerminalFont();
        AcquireKeyboardFocus();
        LaunchProcess();
        LoadAutoplayPrompts();

        // If follow mode is already enabled, engage viewport lock
        if (OpenRCT2::AIAgent::IsFollowEnabled())
        {
            SetViewportLock(true);
        }

        // Initialize workspace path for session logging
        const char* home = std::getenv("HOME");
        if (home && *home)
        {
            _workspacePath = std::filesystem::path(home) / ".openrct2-agent";
        }

        // Get context for later use (window positioning)
        auto* ctx = OpenRCT2::GetContext();

        // Register callbacks for prompt bridge (allows JSON-RPC to send prompts to agent)
        OpenRCT2::AIAgent::SetPromptSender([this](const std::string& text) {
            if (_shellProcess && _shellProcess->IsRunning())
            {
                // Use \r (carriage return) to match what the Enter key sends
                _shellProcess->Write(text + "\r");
                return true;
            }
            return false;
        });

        OpenRCT2::AIAgent::SetStatusGetter([this]() {
            OpenRCT2::AIAgent::AgentStatusInfo info;
            if (!_shellProcess)
            {
                info.status = OpenRCT2::AIAgent::AgentStatus::NotRunning;
            }
            else if (_shellProcess->IsRunning())
            {
                info.status = OpenRCT2::AIAgent::AgentStatus::Running;
            }
            else
            {
                info.status = OpenRCT2::AIAgent::AgentStatus::Exited;
                info.exitCode = _shellProcess->ExitStatus();
            }
            info.lastOutputTimestamp = _lastOutputTimestamp;

            // Add turn completion status from session monitor
            if (_sessionMonitor)
            {
                info.turnComplete = _sessionMonitor->IsTurnComplete();
                auto turnTime = _sessionMonitor->GetLastTurnCompleteTime();
                info.lastTurnCompleteTimestamp = static_cast<uint64_t>(
                    std::chrono::system_clock::to_time_t(turnTime));
            }
            return info;
        });

        OpenRCT2::AIAgent::SetRestartHandler([this]() {
            if (_shellProcess)
            {
                _shellProcess.reset();
            }
            _launchAttempted = false;
            LaunchProcess();
            return _shellProcess != nullptr;
        });

        // Position window in top-right corner, just below the top toolbar
        {
            auto& uiContext = ctx->GetUiContext();
            const int32_t screenWidth = uiContext.GetWidth();
            const int32_t posX = std::max(0, screenWidth - width);
            const int32_t posY = static_cast<int32_t>(kTopToolbarHeight) + 2;
            OpenRCT2::Ui::Windows::WindowSetPosition(*this, ScreenCoordsXY(posX, posY));
        }
    }

    void AIAgentTerminalWindow::onClose()
    {
        if (sAIAgentTerminalInstance == this)
        {
            sAIAgentTerminalInstance = nullptr;
        }

        // Generate HTML session log before closing
        GenerateSessionLog();

        // Release viewport lock so manual panning works after terminal closes
        SetViewportLock(false);

        // Clear prompt bridge callbacks before destroying the shell process
        OpenRCT2::AIAgent::ClearCallbacks();
        ReleaseKeyboardFocus();
        _shellProcess.reset();
        _terminalSession.reset();
    }

    void AIAgentTerminalWindow::ApplySizeConstraints()
    {
        if (_isCollapsed)
        {
            WindowSetResize(*this, kAgentWindowCollapsedMinSize, kAgentWindowCollapsedMaxSize);
        }
        else if (_autoplayEnabled)
        {
            ScreenSize minWithPanel = { kAgentWindowSize.width, kAgentWindowSize.height + kPromptQueuePanelHeight };
            ScreenSize maxWithPanel = { kAgentWindowMaxSize.width, kAgentWindowMaxSize.height + kPromptQueuePanelHeight };
            WindowSetResize(*this, minWithPanel, maxWithPanel);
        }
        else
        {
            WindowSetResize(*this, kAgentWindowSize, kAgentWindowMaxSize);
        }
    }

    void AIAgentTerminalWindow::SetCollapsed(bool collapsed)
    {
        if (_isCollapsed == collapsed)
        {
            return;
        }

        const int16_t preserveRight = static_cast<int16_t>(windowPos.x + width);

        if (collapsed)
        {
            _restoreWidth = std::clamp<int16_t>(width, kAgentWindowSize.width, kAgentWindowMaxSize.width);
        }

        _isCollapsed = collapsed;
        ApplySizeConstraints();

        const int16_t targetWidth = collapsed
            ? GetCollapsedWidth()
            : std::clamp<int16_t>(_restoreWidth, kAgentWindowSize.width, kAgentWindowMaxSize.width);
        const int16_t minHeight = kAgentWindowSize.height;
        const int16_t maxHeight = kAgentWindowMaxSize.height;
        const int16_t targetHeight = std::clamp<int16_t>(height, minHeight, maxHeight);

        const int16_t dw = static_cast<int16_t>(targetWidth - width);
        const int16_t dh = static_cast<int16_t>(targetHeight - height);
        if (dw != 0 || dh != 0)
        {
            OpenRCT2::Ui::Windows::WindowResizeByDelta(*this, dw, dh);
        }

        ScreenCoordsXY targetPos{ static_cast<int32_t>(preserveRight - width), windowPos.y };
        if (auto* context = OpenRCT2::GetContext())
        {
            auto& uiContext = context->GetUiContext();
            const int32_t screenWidth = uiContext.GetWidth();
            const int32_t maxLeft = std::max<int32_t>(0, screenWidth - width);
            targetPos.x = std::clamp<int32_t>(targetPos.x, 0, maxLeft);
        }
        OpenRCT2::Ui::Windows::WindowSetPosition(*this, targetPos);

        if (!_isCollapsed)
        {
            UpdateGeometry();
        }

        invalidate();
        _needsFullRedraw = true;

    }

    void AIAgentTerminalWindow::LaunchProcess()
    {
        _launchAttempted = true;
        _terminalSession.reset();
        _hasSnapshot = false;
        _hasPendingSnapshot = false;
        _pendingSnapshot.Clear();
        _snapshot.Clear();
        _renderedCells.clear();
        _renderedCols = 0;
        _renderedRows = 0;
        _dirtyMaskScratch.clear();
        EnsureSession();
        _hasSeenOutput = false;
        _autoFollowEnabled = true;
        _decSyncState = DecSyncParseState::Normal;
        _decSyncPrivate = false;
        _decSyncHas2026 = false;
        _decSyncParam = -1;
        _decSyncDepth = 0;
        _decSyncJustEnded = false;
        _decSyncStartTickMs = 0;
        _lastOutputTickMs = 0;
        SnapScrollToTail();
        auto geometry = CalculateGeometry();
        _launchPlan = BuildAIAgentLaunchPlan(geometry.cols, geometry.rows);
        if (!_launchPlan.available)
        {
            _errorMessage = _launchPlan.error;
            LOG_WARNING("AIAgentTerminal: Launch plan unavailable: %s", _launchPlan.error.c_str());
            invalidateWidget(WIDX_TERMINAL_CANVAS);
            return;
        }

        std::string error;
        _shellProcess = LaunchShellProcess(_launchPlan.options, error);
        if (!_shellProcess)
        {
            _errorMessage = error;
            LOG_WARNING("AIAgentTerminal: Launch failed: %s", error.c_str());
            invalidateWidget(WIDX_TERMINAL_CANVAS);
            return;
        }

        _statusMessage = "Running: " + _launchPlan.description;
        _errorMessage.clear();
        _needsFullRedraw = true;
        invalidateWidget(WIDX_TERMINAL_CANVAS);

    }

    void AIAgentTerminalWindow::AcquireKeyboardFocus()
    {
        if (_textCaptureActive)
            return;

        WindowStartTextbox(*this, WIDX_HIDDEN_TEXTBOX, u8string{}, 256);
        _textCaptureActive = true;
        _textInputWorking = false;
        _textInputIdleFrames = 0;
        ClearTextInputBuffer();
    }

    void AIAgentTerminalWindow::ReleaseKeyboardFocus()
    {
        if (!_textCaptureActive)
            return;

        WindowCancelTextbox();
        _textCaptureActive = false;
        _textInputWorking = false;
        _textInputIdleFrames = 0;
    }

    void AIAgentTerminalWindow::EnsureKeyboardFocusIntegrity()
    {
        if (!_textCaptureActive)
            return;

        if (!HasKeyboardFocus())
        {
            LOG_VERBOSE("AIAgentTerminal: Lost text input session, reacquiring hidden textbox.");
            ReleaseKeyboardFocus();
            AcquireKeyboardFocus();
            return;
        }

        if (_textInputWorking)
        {
            _textInputIdleFrames++;
            if (_textInputIdleFrames > kTextInputWatchdogFrames)
            {
                LOG_VERBOSE("AIAgentTerminal: Text input idle for %d frames, enabling keycode fallback.", _textInputIdleFrames);
                _textInputWorking = false;
                _textInputIdleFrames = 0;
            }
        }
    }

    bool AIAgentTerminalWindow::HasKeyboardFocus() const
    {
        if (!_textCaptureActive)
            return false;
        if (!ContextIsInputActive())
            return false;

        const auto& textbox = GetCurrentTextBox();
        if (textbox.widgetIndex != WIDX_HIDDEN_TEXTBOX)
            return false;
        if (textbox.window.classification != classification)
            return false;
        return textbox.window.number == number;
    }

    void AIAgentTerminalWindow::onPrepareDraw()
    {
        widgets[WIDX_TERMINAL_CANVAS].type = (_launchAttempted && !_isCollapsed) ? WidgetType::custom : WidgetType::empty;

        const int16_t captionBottom = widgets[WIDX_TITLE].bottom;
        const int16_t sidebarLeft = static_cast<int16_t>(width - kSidebarWidth - 4);
        const int16_t sidebarRight = static_cast<int16_t>(width - 4);
        const int16_t sidebarTop = static_cast<int16_t>(captionBottom + 4);
        const int16_t sidebarBottom = static_cast<int16_t>(height - 4);

        auto& sidebar = widgets[WIDX_SIDEBAR];
        sidebar.left = sidebarLeft;
        sidebar.right = sidebarRight;
        sidebar.top = sidebarTop;
        sidebar.bottom = sidebarBottom;

        // Position all sidebar buttons using consistent vertical layout
        PositionSidebarButton(widgets[WIDX_FOLLOW_BUTTON], sidebarLeft, sidebarTop, 0);
        PositionSidebarButton(widgets[WIDX_MINIMIZE_BUTTON], sidebarLeft, sidebarTop, 1);

        // Autoplay button uses same size as others for consistent box appearance
        PositionSidebarButton(widgets[WIDX_AUTOPLAY_BUTTON], sidebarLeft, sidebarTop, 2);
        PositionSidebarButton(widgets[WIDX_SCROLL_LOCK_BUTTON], sidebarLeft, sidebarTop, 3);

        // Dynamic icon for minimize button based on state
        // Right arrow when expanded (collapse to right), left arrow when collapsed (expand to left)
        auto& minimizeButton = widgets[WIDX_MINIMIZE_BUTTON];
        minimizeButton.image = _isCollapsed ? ImageId(SPR_PREVIOUS) : ImageId(SPR_NEXT);
        minimizeButton.tooltip = _isCollapsed ? STR_AGENT_MAXIMIZE_BUTTON_TIP : STR_AGENT_MINIMIZE_BUTTON_TIP;

        if (OpenRCT2::AIAgent::IsFollowEnabled())
        {
            pressedWidgets |= (1uLL << WIDX_FOLLOW_BUTTON);
        }
        else
        {
            pressedWidgets &= ~(1uLL << WIDX_FOLLOW_BUTTON);
        }
        if (_isCollapsed)
        {
            pressedWidgets |= (1uLL << WIDX_MINIMIZE_BUTTON);
        }
        else
        {
            pressedWidgets &= ~(1uLL << WIDX_MINIMIZE_BUTTON);
        }
        if (_autoplayEnabled)
        {
            pressedWidgets |= (1uLL << WIDX_AUTOPLAY_BUTTON);
        }
        else
        {
            pressedWidgets &= ~(1uLL << WIDX_AUTOPLAY_BUTTON);
        }
        if (_scrollLockEnabled)
        {
            pressedWidgets |= (1uLL << WIDX_SCROLL_LOCK_BUTTON);
        }
        else
        {
            pressedWidgets &= ~(1uLL << WIDX_SCROLL_LOCK_BUTTON);
        }
    }

    void AIAgentTerminalWindow::onDraw(RenderTarget& rt)
    {
        drawWidgets(rt);

        // Draw animated autoplay button (fluttering paper when active)
        // Tab sprite is 31x27, button box is 24x24, so offset to center: (-3, -2)
        const auto& autoplayWidget = widgets[WIDX_AUTOPLAY_BUTTON];
        if (autoplayWidget.type != WidgetType::empty)
        {
            ImageId spriteIdx(SPR_TAB_STATS_0);
            if (_autoplayEnabled)
            {
                // Animate through 7 frames when autoplay is active (fluttering paper)
                spriteIdx = spriteIdx.WithIndexOffset((_animationFrame / 4) % 7);
            }
            GfxDrawSprite(
                rt, spriteIdx, windowPos + ScreenCoordsXY{ autoplayWidget.left - 3, autoplayWidget.top - 2 });
        }
    }

    void AIAgentTerminalWindow::onDrawWidget(WidgetIndex widgetIndex, RenderTarget& rt)
    {
        // Custom background drawing to prevent flickering in the terminal area.
        // The default WidgetFrameDraw fills the ENTIRE window including the terminal canvas,
        // which causes a flash (background color → terminal content) on every redraw.
        // Instead, we draw the frame border + fill only the non-terminal regions.
        if (widgetIndex == WIDX_BACKGROUND && !_isCollapsed && _launchAttempted)
        {
            const auto& bgWidget = widgets[WIDX_BACKGROUND];
            const auto& canvasWidget = widgets[WIDX_TERMINAL_CANVAS];
            auto colour = colours[bgWidget.colour];

            // Window bounds (absolute screen coordinates)
            int32_t winL = windowPos.x + bgWidget.left;
            int32_t winT = windowPos.y + bgWidget.top;
            int32_t winR = windowPos.x + bgWidget.right;
            int32_t winB = windowPos.y + bgWidget.bottom;

            // Terminal canvas bounds (absolute screen coordinates)
            int32_t canvasL = windowPos.x + canvasWidget.left;
            int32_t canvasT = windowPos.y + canvasWidget.top;
            int32_t canvasR = windowPos.x + canvasWidget.right;
            int32_t canvasB = windowPos.y + canvasWidget.bottom;

            // Get fill color from colour map
            uint8_t fillColour = ColourMapA[colour.colour].mid_light;

            // Draw the 3D frame border (outset style)
            Rect::fillInset(
                rt, { { winL, winT }, { winR, winB } }, colour,
                Rect::BorderStyle::outset, Rect::FillBrightness::light, Rect::FillMode::none);

            // Fill regions outside the terminal canvas:
            // 1. Top region (title bar area) - from top of window to top of canvas
            if (canvasT > winT + 1)
            {
                Rect::fill(rt, { { winL + 1, winT + 1 }, { winR - 1, canvasT - 1 } }, fillColour);
            }
            // 2. Left region - from canvas top to canvas bottom, left of canvas
            if (canvasL > winL + 1)
            {
                Rect::fill(rt, { { winL + 1, canvasT }, { canvasL - 1, canvasB } }, fillColour);
            }
            // 3. Right region - from canvas top to canvas bottom, right of canvas
            if (canvasR < winR - 1)
            {
                Rect::fill(rt, { { canvasR + 1, canvasT }, { winR - 1, canvasB } }, fillColour);
            }
            // 4. Bottom region - from bottom of canvas to bottom of window
            if (canvasB < winB - 1)
            {
                Rect::fill(rt, { { winL + 1, canvasB + 1 }, { winR - 1, winB - 1 } }, fillColour);
            }
            return;
        }

        if (widgetIndex == WIDX_TERMINAL_CANVAS)
        {
            if (!_isCollapsed && _launchAttempted)
            {
                DrawTerminalDoubleBuffered(rt, widgets[widgetIndex]);
            }
            return;
        }
        if (widgetIndex == WIDX_SIDEBAR)
        {
            DrawSidebar(rt, widgets[widgetIndex]);
            return;
        }
        if (widgetIndex == WIDX_PROMPT_QUEUE)
        {
            if (_autoplayEnabled)
            {
                DrawPromptQueue(rt);
            }
            return;
        }

        Window::onDrawWidget(widgetIndex, rt);
    }

    void AIAgentTerminalWindow::onMouseDown(WidgetIndex widgetIndex)
    {
        if (widgetIndex == WIDX_TERMINAL_CANVAS)
        {
            AcquireKeyboardFocus();
        }
    }

    void AIAgentTerminalWindow::onMouseUp(WidgetIndex widgetIndex)
    {
        if (widgetIndex == WIDX_CLOSE)
        {
            close();
            return;
        }

        if (widgetIndex == WIDX_FOLLOW_BUTTON)
        {
            OpenRCT2::AIAgent::ToggleFollow(true);
            // Auto-enable/disable viewport lock to match follow mode
            SetViewportLock(OpenRCT2::AIAgent::IsFollowEnabled());
            invalidate();
            return;
        }

        if (widgetIndex == WIDX_MINIMIZE_BUTTON)
        {
            SetCollapsed(!_isCollapsed);
            return;
        }

        if (widgetIndex == WIDX_AUTOPLAY_BUTTON)
        {
            ToggleAutoplay();
            return;
        }

        if (widgetIndex == WIDX_SCROLL_LOCK_BUTTON)
        {
            _scrollLockEnabled = !_scrollLockEnabled;
            if (_scrollLockEnabled)
            {
                // Clear any accumulated wheel delta and snap to tail
                _pendingWheelPx = 0.0;
                SnapScrollToTail();
            }
            else
            {
                // Leaving lock should keep us at the tail and re-enable normal follow.
                _pendingWheelPx = 0.0;
                SnapScrollToTail();
                _needsFullRedraw = true;
                _renderedCells.clear();
                _renderedCols = 0;
                _renderedRows = 0;
                _dirtyMaskScratch.clear();
            }
            invalidate();
            return;
        }
    }

    bool AIAgentTerminalWindow::onMouseWheel(WidgetIndex widgetIndex, int32_t wheel)
    {
        if (widgetIndex != WIDX_TERMINAL_CANVAS)
            return false;
        if (_isCollapsed)
            return false;
        if (_scrollLockEnabled)
        {
            _pendingWheelPx = 0.0;
            return true;  // Consume event but don't scroll
        }
        if (!_terminalSession || _cellHeight <= 0)
            return false;

        const int totalRows = GetTotalRowCount();
        if (totalRows <= _visibleRows)
        {
            _pendingWheelPx = 0.0;
            return false;
        }

        _pendingWheelPx += static_cast<double>(wheel);
        const double pixelsPerRow = static_cast<double>(_cellHeight);
        if (pixelsPerRow <= 0.0)
            return false;

        int deltaRows = static_cast<int>(_pendingWheelPx / pixelsPerRow);
        if (deltaRows == 0)
        {
            return true;
        }

        _pendingWheelPx -= static_cast<double>(deltaRows) * pixelsPerRow;
        ScrollByRows(-deltaRows);
        return true;
    }

    void AIAgentTerminalWindow::onTextInput(WidgetIndex widgetIndex, std::string_view text)
    {
        if (widgetIndex != WIDX_HIDDEN_TEXTBOX)
            return;
        if (!_shellProcess || text.empty())
            return;

        _textInputWorking = true;
        _textInputIdleFrames = 0;

        // Track input for /clear detection
        CheckForClearCommand(text);

        _shellProcess->Write(text);
        ClearTextInputBuffer();
    }

    void AIAgentTerminalWindow::onUpdate()
    {
        _animationFrame++;
        EnsureKeyboardFocusIntegrity();
        PollProcess();
        RefreshSnapshotIfNeeded();

        // Decrement status message timeout and clear when expired
        if (_statusMessageTimeout > 0)
        {
            _statusMessageTimeout--;
            if (_statusMessageTimeout == 0)
            {
                _statusMessage.clear();
                invalidate();
            }
        }

        // Continuous scroll lock enforcement: ensure we stay pinned to tail
        // This catches any edge cases where scroll position might drift
        if (_scrollLockEnabled)
        {
            EnforceScrollLock();
        }
    }

    void AIAgentTerminalWindow::onResize()
    {
        if (!_isCollapsed)
        {
            _restoreWidth = std::clamp<int16_t>(width, kAgentWindowSize.width, kAgentWindowMaxSize.width);
        }
        UpdateGeometry();
        _needsFullRedraw = true;
    }

    bool AIAgentTerminalWindow::HandleKeyboardEvent(const InputEvent& e)
    {
        if (!_textCaptureActive)
            return false;

        if (!_shellProcess)
            return true;

        if (e.state != InputEventState::down)
            return true;

        const bool ctrl = (e.modifiers & KMOD_CTRL) != 0;
        const bool gui = (e.modifiers & KMOD_GUI) != 0;
        const bool shift = (e.modifiers & KMOD_SHIFT) != 0;
        const bool alt = (e.modifiers & KMOD_ALT) != 0;

        if (!alt && ((gui && e.button == SDLK_DOWN) || (ctrl && e.button == SDLK_END)))
        {
            ResumeAutoFollow();
            return true;
        }

        if ((ctrl || gui) && shift && e.button == SDLK_f)
        {
            OpenRCT2::AIAgent::ToggleFollow(true);
            SetViewportLock(OpenRCT2::AIAgent::IsFollowEnabled());
            return true;
        }

        constexpr uint32_t kPasteModifierMask = KMOD_GUI | KMOD_CTRL;
        if ((e.modifiers & kPasteModifierMask) != 0)
        {
            switch (e.button)
            {
                case SDLK_LGUI:
                case SDLK_RGUI:
                case SDLK_LCTRL:
                case SDLK_RCTRL:
                    _lastPasteModifierTick = SDL_GetTicks64();
                    _pendingPasteFallback = true;
                    break;
                default:
                    _pendingPasteFallback = false;
                    break;
            }
        }

        if (TryHandleClipboardPasteFallback(e))
        {
            return true;
        }

        auto sequence = BuildKeySequence(e);
        if (!sequence.empty())
        {
            // Track input for /clear detection
            CheckForClearCommand(sequence);
            _shellProcess->Write(sequence);
        }
        return true;
    }

    bool AIAgentTerminalWindow::WantsKeyboardCapture() const
    {
        return _textCaptureActive;
    }

    void AIAgentTerminalWindow::PollProcess()
    {
        if (!_shellProcess)
            return;

        ssize_t bytesRead = 0;
        size_t totalRead = 0;
        bool loggedPreview = false;
        _ptyDrainBuffer.clear();

        while (true)
        {
            bytesRead = _shellProcess->Read(_ptyReadBuffer.data(), _ptyReadBuffer.size());
            if (bytesRead <= 0)
            {
                break;
            }

            if (_autoplayEnabled && _autoplayWaitingForResponse && !loggedPreview)
            {
                std::string preview(reinterpret_cast<char*>(_ptyReadBuffer.data()),
                    std::min(static_cast<ssize_t>(80), bytesRead));
                // Replace control chars for logging
                for (char& c : preview)
                {
                    if (c < 32 && c != '\n') c = '.';
                }
                LOG_VERBOSE("Auto-play: Got %zd bytes from PTY: %.80s...", bytesRead, preview.c_str());
                loggedPreview = true;
            }

            const size_t chunk = static_cast<size_t>(bytesRead);
            _ptyDrainBuffer.insert(_ptyDrainBuffer.end(), _ptyReadBuffer.begin(), _ptyReadBuffer.begin() + chunk);
            totalRead += chunk;
        }

        if (totalRead > 0)
        {
            EnsureSession();
            UpdateSynchronizedUpdateState({ _ptyDrainBuffer.data(), totalRead });
            _terminalSession->FeedOutput({ _ptyDrainBuffer.data(), totalRead });
            // Update timestamp for idle detection by orchestrator
            _lastOutputTimestamp = static_cast<uint64_t>(std::time(nullptr));
            _lastOutputTickMs = SDL_GetTicks64();
            _hasSeenOutput = true;
        }

        // Autoplay logic runs separately from output processing
        if (_autoplayEnabled && _shellProcess->IsRunning())
        {
            // Handle deferred Enter key (sent after text with a small delay)
            if (_autoplayPendingEnter)
            {
                if (_autoplayEnterDelayFrames > 0)
                {
                    _autoplayEnterDelayFrames--;
                }
                else
                {
                    // Send the Enter key now (CR)
                    bool enterOk = _shellProcess->Write("\r");
                    LOG_INFO("Auto-play: Sent deferred Enter (CR), result=%s", enterOk ? "ok" : "FAIL");
                    _autoplayPendingEnter = false;
                    _autoplayWaitingForResponse = true;
                    // Update prompt queue display to show "Working..."
                    invalidateWidget(WIDX_PROMPT_QUEUE);
                }
                // Don't process other autoplay logic while Enter is pending
                // (fall through to process exit check below)
            }
            // Session file-based turn detection: poll when waiting for response
            // (Claude's TUI sends constant screen updates, so bytesRead > 0 even when idle)
            // Throttle to every 15 frames (~250ms at 60fps) to reduce file I/O overhead
            else if (_autoplayWaitingForResponse && _sessionMonitor)
            {
                _sessionMonitorPollCounter++;
                if (_sessionMonitorPollCounter >= 15)
                {
                    _sessionMonitorPollCounter = 0;

                    // First, try to discover which session file belongs to our agent
                    // This detects the file that changed after we sent our prompt
                    if (!_sessionMonitor->IsSessionLocked())
                    {
                        if (_sessionMonitor->DiscoverActiveSession())
                        {
                            auto sessionFile = _sessionMonitor->GetSessionFilePath();
                            LOG_INFO("Auto-play: Locked onto agent session file: %s",
                                sessionFile ? sessionFile->filename().string().c_str() : "unknown");
                        }
                        // Keep trying to discover until we lock on
                        return;
                    }

                    // Poll the session monitor for turn completion
                    if (_sessionMonitor->Poll() || _sessionMonitor->IsTurnComplete())
                    {
                        _autoplayWaitingForResponse = false;
                        _autoplayDelayFrames = kAutoplayDelayAfterResponse; // Start 30-sec delay
                        // Advance to next prompt NOW that current one is complete
                        _autoplayPromptIndex++;
                        LOG_INFO("Auto-play: Claude finished (detected via session file), advancing to prompt %zu, starting 30-second delay",
                            _autoplayPromptIndex);
                        // Update prompt queue display to show countdown
                        invalidateWidget(WIDX_PROMPT_QUEUE);
                    }
                }
            }
            // Decrement delay timer regardless of output (so startup delay works during Claude boot)
            else if (_autoplayDelayFrames > 0)
            {
                _autoplayDelayFrames--;
                // Invalidate prompt queue widget once per second (every 40 ticks) to update countdown display
                if (_autoplayDelayFrames % 40 == 0)
                {
                    invalidateWidget(WIDX_PROMPT_QUEUE);
                }
                // Log every 10 seconds (400 ticks at 40 ticks/sec)
                if (_autoplayDelayFrames % 400 == 0 && _autoplayDelayFrames > 0)
                {
                    LOG_VERBOSE("Auto-play: Delay countdown: %d frames remaining", _autoplayDelayFrames);
                }
            }
            // Ready to send next prompt (delay timer has expired)
            // Note: Don't check bytesRead - Claude's TUI sends constant screen updates even when idle
            else if (!_autoplayWaitingForResponse && !_autoplayPendingEnter)
            {
                LOG_INFO("Auto-play: Delay expired, sending next prompt");
                SendNextAutoplayPrompt();
            }
        }

        bool running = _shellProcess->IsRunning();
        if (_lastProcessRunning && !running)
        {
            auto exitCode = _shellProcess->ExitStatus();
            _statusMessage = "Process exited with code " + std::to_string(exitCode);
        }
        _lastProcessRunning = running;
    }

    void AIAgentTerminalWindow::UpdateSynchronizedUpdateState(std::span<const uint8_t> bytes)
    {
        auto ResetCsi = [&]() {
            _decSyncState = DecSyncParseState::Normal;
            _decSyncPrivate = false;
            _decSyncHas2026 = false;
            _decSyncParam = -1;
        };

        for (uint8_t byte : bytes)
        {
            switch (_decSyncState)
            {
                case DecSyncParseState::Normal:
                    if (byte == 0x1B)
                    {
                        _decSyncState = DecSyncParseState::Esc;
                    }
                    break;
                case DecSyncParseState::Esc:
                    if (byte == '[')
                    {
                        _decSyncState = DecSyncParseState::Csi;
                        _decSyncPrivate = false;
                        _decSyncHas2026 = false;
                        _decSyncParam = -1;
                    }
                    else
                    {
                        _decSyncState = (byte == 0x1B) ? DecSyncParseState::Esc : DecSyncParseState::Normal;
                    }
                    break;
                case DecSyncParseState::Csi:
                    if (byte == 0x1B)
                    {
                        _decSyncState = DecSyncParseState::Esc;
                        break;
                    }
                    if (byte == '?')
                    {
                        _decSyncPrivate = true;
                        break;
                    }
                    if (byte >= '0' && byte <= '9')
                    {
                        if (_decSyncParam < 0)
                        {
                            _decSyncParam = 0;
                        }
                        _decSyncParam = _decSyncParam * 10 + (byte - '0');
                        break;
                    }
                    if (byte == ';')
                    {
                        if (_decSyncParam == 2026)
                        {
                            _decSyncHas2026 = true;
                        }
                        _decSyncParam = -1;
                        break;
                    }
                    if (byte >= 0x20 && byte <= 0x2f)
                    {
                        // Intermediate bytes in CSI; ignore.
                        break;
                    }
                    if (byte >= 0x40 && byte <= 0x7e)
                    {
                        if (_decSyncParam == 2026)
                        {
                            _decSyncHas2026 = true;
                        }
                        if (_decSyncPrivate && _decSyncHas2026)
                        {
                            if (byte == 'h')
                            {
                                if (_decSyncDepth == 0)
                                {
                                    _decSyncJustEnded = false;
                                    _decSyncStartTickMs = SDL_GetTicks64();
                                }
                                _decSyncDepth++;
                            }
                            else if (byte == 'l')
                            {
                                if (_decSyncDepth > 0)
                                {
                                    _decSyncDepth--;
                                }
                                if (_decSyncDepth == 0)
                                {
                                    _decSyncJustEnded = true;
                                    _decSyncStartTickMs = 0;
                                }
                            }
                        }
                        ResetCsi();
                        break;
                    }
                    ResetCsi();
                    break;
            }
        }
    }

    void AIAgentTerminalWindow::RefreshSnapshotIfNeeded()
    {
        if (!_terminalSession)
            return;

        TerminalSnapshot next;
        if (_terminalSession->ConsumeSnapshot(next))
        {
            _pendingSnapshot = std::move(next);
            _hasPendingSnapshot = true;
        }

        if (!_hasPendingSnapshot)
            return;

        const bool altScreenActive = _terminalSession->IsAltScreenActive();
        const bool altScreenChanged = (altScreenActive != _altScreenActive);
        if (altScreenChanged)
        {
            _altScreenActive = altScreenActive;
            _needsFullRedraw = true;
            _renderedCells.clear();
            _renderedCols = 0;
            _renderedRows = 0;
            _dirtyMaskScratch.clear();
            _pendingWheelPx = 0.0;
            if (_altScreenActive)
            {
                _scrollHeadRow = 0;
            }
        }

        const uint64_t nowMs = SDL_GetTicks64();
        const bool lockMode = _scrollLockEnabled;
        const bool followMode = lockMode || _autoFollowEnabled;
        bool decSyncTimedOut = false;
        if (_decSyncDepth > 0 && _decSyncStartTickMs != 0)
        {
            const uint64_t holdLimitMs = lockMode
                ? kTerminalDecSyncMaxHoldMs
                : (followMode ? kTerminalMaxRenderLatencyMsFollow : kTerminalDecSyncMaxHoldMs);
            decSyncTimedOut = (nowMs - _decSyncStartTickMs) >= holdLimitMs;
        }

        if (_decSyncDepth > 0)
        {
            if (!decSyncTimedOut)
            {
                return;
            }
            _decSyncStartTickMs = nowMs;
        }

        bool forceSyncRender = false;
        if (_decSyncJustEnded)
        {
            forceSyncRender = true;
            _decSyncJustEnded = false;
        }

        const uint64_t quietWindowMs = lockMode
            ? kTerminalQuietWindowMsLock
            : (followMode ? kTerminalQuietWindowMsFollow : kTerminalQuietWindowMs);
        const uint64_t maxLatencyMs = lockMode
            ? kTerminalMaxRenderLatencyMsLock
            : (followMode ? kTerminalMaxRenderLatencyMsFollow : kTerminalMaxRenderLatencyMs);
        const uint64_t sinceOutputMs = _lastOutputTickMs > 0 ? (nowMs - _lastOutputTickMs) : quietWindowMs;
        const uint64_t sinceRenderMs = _lastRenderTickMs > 0 ? (nowMs - _lastRenderTickMs) : maxLatencyMs;
        const bool outputQuiet = sinceOutputMs >= quietWindowMs;
        const bool maxLatencyReached = sinceRenderMs >= maxLatencyMs;
        if (!forceSyncRender && !decSyncTimedOut && !outputQuiet && !maxLatencyReached && !altScreenChanged)
        {
            return;
        }

        // Rate-limit visual refreshes.
        const uint16_t framesSinceLastRender = _animationFrame - _lastRenderFrame;
        const uint16_t minRefreshInterval = lockMode ? kTerminalRefreshIntervalLock : kTerminalRefreshInterval;
        if (!forceSyncRender && !decSyncTimedOut && framesSinceLastRender < minRefreshInterval)
        {
            return;
        }

        // Check if user was at the tail before updating snapshot
        // We want to auto-scroll if they're already at the bottom (normal terminal behavior)
        const int32_t oldTotalRows = GetTotalRowCount();
        const int32_t oldMaxHead = std::max<int32_t>(0, oldTotalRows - _visibleRows);
        const bool wasAtTail = (_scrollHeadRow >= oldMaxHead);

        _snapshot = std::move(_pendingSnapshot);
        _hasSnapshot = true;
        _hasPendingSnapshot = false;

        // Auto-scroll to tail if:
        // 1. Scroll lock is enabled (force stay at bottom), OR
        // 2. User was already at the tail (normal terminal behavior)
        if (_scrollLockEnabled || _altScreenActive || _autoFollowEnabled || wasAtTail)
        {
            SnapScrollToTail();
        }

        _lastRenderFrame = _animationFrame;
        _lastRenderTickMs = nowMs;

        invalidateWidget(WIDX_TERMINAL_CANVAS);
        _needsFullRedraw = false;
    }

    void AIAgentTerminalWindow::UpdateCanvasWidgetBounds()
    {
        if (widgets.size() <= WIDX_TERMINAL_CANVAS)
            return;

        auto& canvas = widgets[WIDX_TERMINAL_CANVAS];
        const int16_t captionBottom = widgets[WIDX_TITLE].bottom;
        const int16_t left = 4;
        const int16_t top = static_cast<int16_t>(captionBottom + 4);
        const int16_t minRight = static_cast<int16_t>(left + 32);
        const int16_t minBottom = static_cast<int16_t>(top + 32);
        const int16_t maxRight = static_cast<int16_t>(width - 5 - (kSidebarWidth + kSidebarGap));
        // Reserve space for prompt queue panel when autoplay is enabled
        const int16_t bottomReserve = _autoplayEnabled ? kPromptQueuePanelHeight : 0;
        const int16_t maxBottom = static_cast<int16_t>(height - 5 - bottomReserve);

        canvas.left = left;
        canvas.top = top;
        canvas.right = std::max<int16_t>(minRight, maxRight);
        canvas.bottom = std::max<int16_t>(minBottom, maxBottom);

        // Also update prompt queue bounds if visible
        if (_autoplayEnabled)
        {
            UpdatePromptQueueBounds();
        }
    }

    void AIAgentTerminalWindow::EnsureSession()
    {
        if (_terminalSession)
            return;

        auto geometry = CalculateGeometry();
        _visibleCols = geometry.cols;
        _visibleRows = geometry.rows;
        _terminalSession = std::make_unique<TerminalSession>(_visibleCols, _visibleRows);
        _altScreenActive = false;
        _hasSeenOutput = false;
    }

    void AIAgentTerminalWindow::EnsureTerminalFont()
    {
#ifndef DISABLE_TTF
        auto& pipeline = TerminalFontPipeline::Instance();
        pipeline.EnsureLoaded();
        if (pipeline.IsReady())
        {
            _terminalFontReady = true;
            _cellWidth = pipeline.GetCellWidth();
            _cellHeight = pipeline.GetCellHeight();
            _terminalGlyphHeight = pipeline.GetGlyphHeight();
            _terminalHintingThreshold = pipeline.GetHintingThreshold();
        }
        else
        {
            _terminalFontReady = false;
        }
#else
        _terminalFontReady = false;
#endif
        UpdateRendererWarnings();
    }

    void AIAgentTerminalWindow::UpdateRendererWarnings()
    {
        _rendererWarnings.clear();
        if (!kLibVTermAvailable)
        {
            _rendererWarnings.emplace_back(
                "Compatibility renderer active: ANSI colours and box drawing are limited.");
        }
#ifdef DISABLE_TTF
        _rendererWarnings.emplace_back(
            "Agent Mono font pipeline disabled—build with TTF support to render Unicode art.");
#else
        if (!_terminalFontReady)
        {
            _rendererWarnings.emplace_back(
                "Agent Mono font unavailable—install JetBrains Mono assets for box-drawing glyphs.");
        }
#endif
    }

    int32_t AIAgentTerminalWindow::GetCellPixelWidth(const TerminalCell& cell) const
    {
        return cell.wide ? _cellWidth * 2 : _cellWidth;
    }

    std::vector<std::string> AIAgentTerminalWindow::BuildStatusLines(const std::string& primaryMessage) const
    {
        std::vector<std::string> lines;
        if (!primaryMessage.empty())
        {
            lines.push_back(primaryMessage);
        }
        lines.insert(lines.end(), _rendererWarnings.begin(), _rendererWarnings.end());
        return lines;
    }

    std::vector<std::string> AIAgentTerminalWindow::CollectStatusLines() const
    {
        std::string primary;
        if (!_errorMessage.empty())
        {
            primary = _errorMessage;
        }
        else if (!_statusMessage.empty())
        {
            primary = _statusMessage;
        }
        else if (!_workspacePath.empty())
        {
            // Default: show workspace name
            primary = _workspacePath.filename().string();
        }

        auto lines = BuildStatusLines(primary);
        if (lines.empty() && (!_hasSnapshot || !_hasSeenOutput))
        {
            lines.emplace_back("Launching AI Agent terminal...");
        }
        return lines;
    }

    void AIAgentTerminalWindow::DrawCellGlyph(
        RenderTarget& rt, const ScreenCoordsXY& cellPos, int32_t cellWidthPx, const TerminalCell& cell) const
    {
#ifndef DISABLE_TTF
        if (!_terminalFontReady)
            return;

        auto& pipeline = TerminalFontPipeline::Instance();
        auto* font = pipeline.GetFontForCodepoint(cell.codepoint);
        if (font == nullptr)
            return;

        if (cell.codepoint <= U' ')
            return;

        utf8 buffer[8] = {};
        utf8* cursor = UTF8WriteCodepoint(buffer, static_cast<uint32_t>(cell.codepoint));
        *cursor = '\0';

        TTFSurface* surface = TTFSurfaceCacheGetOrAdd(font, buffer);
        if (surface == nullptr)
            return;

        auto* drawingEngine = rt.DrawingEngine;
        if (drawingEngine == nullptr)
            return;
        auto* drawingContext = drawingEngine->GetDrawingContext();
        if (drawingContext == nullptr)
            return;

        const uint8_t foreground = TerminalPaletteMapper::Instance().Map(cell.foregroundRgb);
        TextDrawInfo drawInfo{};
        drawInfo.palette[1] = foreground;
        drawInfo.palette[3] = foreground;

        const int32_t glyphWidth = surface->w;
        const int32_t glyphHeight = surface->h;
        int32_t drawX = cellPos.x + (cellWidthPx - glyphWidth) / 2;
        int32_t drawY = cellPos.y + (_cellHeight - glyphHeight) / 2;
        const int32_t maxX = std::max(0, rt.width - glyphWidth);
        const int32_t maxY = std::max(0, rt.height - glyphHeight);
        drawX = std::clamp(drawX, 0, maxX);
        drawY = std::clamp(drawY, 0, maxY);

        drawingContext->DrawTTFBitmap(rt, &drawInfo, surface, drawX, drawY, _terminalHintingThreshold);
        if (cell.bold)
        {
            drawingContext->DrawTTFBitmap(rt, &drawInfo, surface, drawX + 1, drawY, _terminalHintingThreshold);
        }
        if (cell.underline)
        {
            const ScreenCoordsXY underlineStart = cellPos + ScreenCoordsXY{ 0, _cellHeight - 2 };
            const ScreenCoordsXY underlineEnd = underlineStart + ScreenCoordsXY{ cellWidthPx - 1, 1 };
            Rect::fill(rt, { underlineStart, underlineEnd }, static_cast<int32_t>(foreground));
        }
#else
        (void)rt;
        (void)cellPos;
        (void)cellWidthPx;
        (void)cell;
#endif
    }

    void AIAgentTerminalWindow::UpdateGeometry()
    {
        if (_isCollapsed)
            return;

        UpdateCanvasWidgetBounds();
        auto geometry = CalculateGeometry();
        if (geometry.cols <= 0 || geometry.rows <= 0)
            return;

        bool changed = geometry.cols != _visibleCols || geometry.rows != _visibleRows;
        _visibleCols = geometry.cols;
        _visibleRows = geometry.rows;

        if (_terminalSession && changed)
        {
            _terminalSession->Resize(_visibleCols, _visibleRows);
            _terminalSession->ForceFullRefresh();
        }

        if (_shellProcess && changed)
        {
            _shellProcess->Resize(_visibleCols, _visibleRows);
        }

        if (changed)
        {
            _needsFullRedraw = true;
            _renderedCells.clear();
            _renderedCols = 0;
            _renderedRows = 0;
            _dirtyMaskScratch.clear();
            _pendingWheelPx = 0.0;
            if (_scrollLockEnabled || _altScreenActive)
            {
                _scrollHeadRow = 0;
            }
        }

        ClampScrollHead();
    }

    TerminalGeometry AIAgentTerminalWindow::CalculateGeometry() const
    {
        const auto& widget = widgets[WIDX_TERMINAL_CANVAS];
        const int32_t widthPx = std::max(2, widget.right - widget.left - kTerminalPadding * 2);
        const int32_t heightPx = std::max(2, widget.bottom - widget.top - kTerminalPadding * 2);
        int32_t cols = std::max(20, widthPx / std::max(1, _cellWidth));
        int32_t rows = std::max(10, heightPx / std::max(1, _cellHeight));
        return { cols, rows, widthPx, heightPx };
    }

    void AIAgentTerminalWindow::EnsureOffscreenBuffer(int32_t width, int32_t height)
    {
        if (_offscreenWidth == width && _offscreenHeight == height && _offscreenBuffer)
            return;

        // Allocate new buffer
        const size_t bufferSize = static_cast<size_t>(width) * height;
        _offscreenBuffer = std::make_unique<uint8_t[]>(bufferSize);
        _offscreenWidth = width;
        _offscreenHeight = height;

        // Clear to background color
        std::fill_n(_offscreenBuffer.get(), bufferSize, ColourMapA[COLOUR_BLACK].mid_dark);
    }

    void AIAgentTerminalWindow::BlitOffscreenToScreen(
        RenderTarget& screenRT, const ScreenCoordsXY& destPos, int32_t width, int32_t height)
    {
        if (!_offscreenBuffer || width <= 0 || height <= 0)
            return;

        // Convert screen coordinates to buffer-relative coordinates
        // (same transformation that FillRect uses internally)
        int32_t srcX = 0, srcY = 0;
        int32_t dstX = destPos.x - screenRT.x;
        int32_t dstY = destPos.y - screenRT.y;
        int32_t copyWidth = width, copyHeight = height;

        // Clip left edge
        if (dstX < 0)
        {
            srcX = -dstX;
            copyWidth += dstX;
            dstX = 0;
        }
        // Clip top edge
        if (dstY < 0)
        {
            srcY = -dstY;
            copyHeight += dstY;
            dstY = 0;
        }
        // Clip right edge
        if (dstX + copyWidth > screenRT.width)
        {
            copyWidth = screenRT.width - dstX;
        }
        // Clip bottom edge
        if (dstY + copyHeight > screenRT.height)
        {
            copyHeight = screenRT.height - dstY;
        }

        if (copyWidth <= 0 || copyHeight <= 0)
            return;

        // Copy row by row from offscreen buffer to screen
        const int32_t srcStride = _offscreenWidth;
        const int32_t dstStride = screenRT.LineStride();
        const uint8_t* srcRow = _offscreenBuffer.get() + srcY * srcStride + srcX;
        uint8_t* dstRow = screenRT.bits + dstY * dstStride + dstX;

        for (int32_t y = 0; y < copyHeight; y++)
        {
            std::memcpy(dstRow, srcRow, copyWidth);
            srcRow += srcStride;
            dstRow += dstStride;
        }
    }

    void AIAgentTerminalWindow::DrawTerminalDoubleBuffered(RenderTarget& screenRT, const Widget& widget)
    {
        // Use full widget size (including padding) to avoid unfilled gaps.
        // Widget coordinates are inclusive, so add 1 for actual pixel dimensions.
        const int32_t widgetWidth = widget.right - widget.left + 1;
        const int32_t widgetHeight = widget.bottom - widget.top + 1;
        const int32_t contentWidth = widgetWidth - kTerminalPadding * 2;
        const int32_t contentHeight = widgetHeight - kTerminalPadding * 2;

        if (contentWidth <= 0 || contentHeight <= 0)
            return;

        const auto lines = CollectStatusLines();
        const bool overlayVisible = !lines.empty();
        const int32_t statusLineHeight = (_cellHeight * 7) / 10;
        const int32_t overlayHeightPx = overlayVisible ? static_cast<int32_t>(lines.size()) * statusLineHeight : 0;
        std::vector<TerminalCell> currentCells;
        if (_hasSnapshot)
        {
            BuildVisibleCells(currentCells);
        }

        const bool bufferResized = (_offscreenWidth != widgetWidth || _offscreenHeight != widgetHeight || !_offscreenBuffer);
        // Ensure offscreen buffer covers the entire widget area
        EnsureOffscreenBuffer(widgetWidth, widgetHeight);

        // Create a RenderTarget pointing to our offscreen buffer
        RenderTarget offscreenRT{};
        offscreenRT.bits = _offscreenBuffer.get();
        offscreenRT.x = 0;
        offscreenRT.y = 0;
        offscreenRT.width = widgetWidth;
        offscreenRT.height = widgetHeight;
        offscreenRT.pitch = 0; // No padding in our buffer
        offscreenRT.zoom_level = screenRT.zoom_level;
        offscreenRT.DrawingEngine = screenRT.DrawingEngine;

        bool forceFullRedraw = _needsFullRedraw || bufferResized || !_hasSnapshot;
        if (!forceFullRedraw)
        {
            forceFullRedraw = (_renderedCols != _snapshot.cols) || (_renderedRows != _visibleRows)
                || (_renderedCells.size() != currentCells.size());
        }
        if (!forceFullRedraw)
        {
            forceFullRedraw = (_lastOverlayVisible != overlayVisible) || (_lastOverlayHeightPx != overlayHeightPx);
        }

        if (forceFullRedraw)
        {
            // Draw terminal content to offscreen buffer (includes padding fill)
            DrawTerminalToBuffer(offscreenRT, widgetWidth, widgetHeight, lines);
            _renderedCells = std::move(currentCells);
            _renderedCols = _hasSnapshot ? _snapshot.cols : 0;
            _renderedRows = _hasSnapshot ? _visibleRows : 0;
            _needsFullRedraw = false;
        }
        else
        {
            DrawTerminalDirty(offscreenRT, widgetWidth, widgetHeight, currentCells, lines);
        }

        _lastOverlayVisible = overlayVisible;
        _lastOverlayHeightPx = overlayHeightPx;

        // Blit the complete widget frame to screen in one operation
        ScreenCoordsXY destPos = windowPos + ScreenCoordsXY{ widget.left, widget.top };
        BlitOffscreenToScreen(screenRT, destPos, widgetWidth, widgetHeight);
    }

    void AIAgentTerminalWindow::DrawTerminalToBuffer(
        RenderTarget& rt, int32_t widgetWidth, int32_t widgetHeight, const std::vector<std::string>& lines) const
    {
        // Fill entire widget area with terminal background color (eliminates gaps)
        ScreenCoordsXY origin{ 0, 0 };
        ScreenCoordsXY widgetBottomRight{ widgetWidth - 1, widgetHeight - 1 };
        Rect::fill(rt, { origin, widgetBottomRight }, ColourMapA[COLOUR_BLACK].mid_dark);

        // Content area is inset by padding
        const int32_t contentWidth = widgetWidth - kTerminalPadding * 2;
        const int32_t contentHeight = widgetHeight - kTerminalPadding * 2;
        ScreenCoordsXY contentOrigin{ kTerminalPadding, kTerminalPadding };

        if (_hasSnapshot)
        {
            DrawCells(rt, contentOrigin, contentWidth, contentHeight);
        }

        DrawStatusOverlay(rt, contentOrigin, contentWidth, contentHeight, lines);
    }

    void AIAgentTerminalWindow::BuildVisibleCells(std::vector<TerminalCell>& out) const
    {
        const int32_t cols = _snapshot.cols;
        if (!_hasSnapshot || cols <= 0 || _visibleRows <= 0)
        {
            out.clear();
            return;
        }

        const auto blankCell = MakeBlankTerminalCell();
        out.resize(static_cast<size_t>(_visibleRows) * static_cast<size_t>(cols));

        const int32_t totalRows = GetTotalRowCount();
        const int32_t rowsToDraw = std::min(_visibleRows, totalRows);
        const int32_t maxHead = std::max<int32_t>(0, totalRows - rowsToDraw);
        const int32_t firstRow = std::clamp(_scrollHeadRow, 0, maxHead);

        for (int32_t screenRow = 0; screenRow < _visibleRows; screenRow++)
        {
            const int32_t rowIndex = firstRow + screenRow;
            if (rowIndex < totalRows)
            {
                CopyRowIntoBuffer(rowIndex, _rowScratch);
            }
            else
            {
                _rowScratch.assign(static_cast<size_t>(cols), blankCell);
            }

            if (_rowScratch.size() < static_cast<size_t>(cols))
            {
                _rowScratch.resize(static_cast<size_t>(cols), blankCell);
            }

            auto dest = out.begin() + static_cast<size_t>(screenRow) * static_cast<size_t>(cols);
            std::copy_n(_rowScratch.begin(), cols, dest);
        }
    }

    void AIAgentTerminalWindow::DrawRowCells(
        RenderTarget& rt, const ScreenCoordsXY& rowOrigin, std::span<const TerminalCell> row) const
    {
        const int32_t cols = static_cast<int32_t>(row.size());
        if (cols <= 0)
            return;

        for (int32_t col = 0; col < cols; col++)
        {
            DrawCellAt(rt, rowOrigin, col, row[static_cast<size_t>(col)]);
        }
    }

    void AIAgentTerminalWindow::DrawCellAt(
        RenderTarget& rt, const ScreenCoordsXY& rowOrigin, int32_t col, const TerminalCell& cell) const
    {
        if (cell.continuation)
            return;

        const int32_t cellWidthPx = GetCellPixelWidth(cell);
        ScreenCoordsXY cellPos = rowOrigin + ScreenCoordsXY{ col * _cellWidth, 0 };
        ScreenCoordsXY cellEnd = cellPos + ScreenCoordsXY{ cellWidthPx - 1, _cellHeight - 1 };
        const auto background = TerminalPaletteMapper::Instance().Map(cell.backgroundRgb);
        Rect::fill(rt, { cellPos, cellEnd }, static_cast<int32_t>(background));

        if (cell.codepoint <= U' ')
            return;

        DrawCellGlyph(rt, cellPos, cellWidthPx, cell);
    }

    void AIAgentTerminalWindow::DrawCells(
        RenderTarget& rt, const ScreenCoordsXY& origin, int32_t canvasWidth, int32_t canvasHeight) const
    {
        if (!_hasSnapshot)
            return;

        const int32_t cols = _snapshot.cols;
        if (cols <= 0 || _cellHeight <= 0)
            return;

        const int32_t totalRows = GetTotalRowCount();
        const int32_t rowsToDraw = std::min(_visibleRows, totalRows);
        const int32_t maxHead = std::max<int32_t>(0, totalRows - rowsToDraw);
        const int32_t firstRow = std::clamp(_scrollHeadRow, 0, maxHead);
        const auto blankCell = MakeBlankTerminalCell();

        for (int32_t screenRow = 0; screenRow < _visibleRows; screenRow++)
        {
            int32_t rowIndex = firstRow + screenRow;
            if (rowIndex < totalRows)
            {
                CopyRowIntoBuffer(rowIndex, _rowScratch);
            }
            else
            {
                _rowScratch.assign(static_cast<size_t>(cols), blankCell);
            }

            if (_rowScratch.size() < static_cast<size_t>(cols))
            {
                _rowScratch.resize(static_cast<size_t>(cols), blankCell);
            }

            auto rowOrigin = origin + ScreenCoordsXY{ 0, screenRow * _cellHeight };
            DrawRowCells(rt, rowOrigin, _rowScratch);
        }
    }

    void AIAgentTerminalWindow::DrawTerminalDirty(
        RenderTarget& rt, int32_t widgetWidth, int32_t widgetHeight, const std::vector<TerminalCell>& cells,
        const std::vector<std::string>& lines)
    {
        const int32_t contentWidth = widgetWidth - kTerminalPadding * 2;
        const int32_t contentHeight = widgetHeight - kTerminalPadding * 2;
        ScreenCoordsXY origin{ kTerminalPadding, kTerminalPadding };

        if (!_hasSnapshot || cells.empty() || _snapshot.cols <= 0 || _visibleRows <= 0)
        {
            DrawTerminalToBuffer(rt, widgetWidth, widgetHeight, lines);
            _renderedCells = cells;
            _renderedCols = _hasSnapshot ? _snapshot.cols : 0;
            _renderedRows = _hasSnapshot ? _visibleRows : 0;
            _needsFullRedraw = false;
            return;
        }

        const int32_t cols = _snapshot.cols;
        const int32_t rows = _visibleRows;
        if (static_cast<int32_t>(cells.size()) != rows * cols)
        {
            DrawTerminalToBuffer(rt, widgetWidth, widgetHeight, lines);
            _renderedCells = cells;
            _renderedCols = cols;
            _renderedRows = rows;
            _needsFullRedraw = false;
            return;
        }
        if (_renderedCells.size() != cells.size())
        {
            DrawTerminalToBuffer(rt, widgetWidth, widgetHeight, lines);
            _renderedCells = cells;
            _renderedCols = cols;
            _renderedRows = rows;
            _needsFullRedraw = false;
            return;
        }

        const size_t rowStride = static_cast<size_t>(cols);
        for (int32_t row = 0; row < rows; row++)
        {
            const size_t rowOffset = static_cast<size_t>(row) * rowStride;
            bool dirtyRow = false;
            bool forceRowDraw = false;
            for (int32_t col = 0; col < cols; col++)
            {
                if (!CellsEqual(cells[rowOffset + static_cast<size_t>(col)],
                        _renderedCells[rowOffset + static_cast<size_t>(col)]))
                {
                    dirtyRow = true;
                    break;
                }
            }
            if (!dirtyRow)
            {
                continue;
            }

            _dirtyMaskScratch.assign(static_cast<size_t>(cols), 0);
            int32_t dirtyCount = 0;
            auto markDirty = [&](int32_t colIndex) {
                if (colIndex < 0 || colIndex >= cols)
                {
                    return;
                }
                const size_t idx = static_cast<size_t>(colIndex);
                if (_dirtyMaskScratch[idx] == 0)
                {
                    _dirtyMaskScratch[idx] = 1;
                    dirtyCount++;
                }
            };

            for (int32_t col = 0; col < cols; col++)
            {
                const size_t idx = rowOffset + static_cast<size_t>(col);
                const auto& currentCell = cells[idx];
                const auto& previousCell = _renderedCells[idx];
                if (CellsEqual(currentCell, previousCell))
                {
                    continue;
                }

#ifndef DISABLE_TTF
                if (!forceRowDraw && _terminalFontReady)
                {
                    auto mayOverhang = [&](const TerminalCell& cell) -> bool {
                        if (cell.codepoint <= U' ')
                            return false;
                        auto& pipeline = TerminalFontPipeline::Instance();
                        auto* font = pipeline.GetFontForCodepoint(cell.codepoint);
                        if (font == nullptr)
                            return false;
                        utf8 buffer[8] = {};
                        utf8* cursor = UTF8WriteCodepoint(buffer, static_cast<uint32_t>(cell.codepoint));
                        *cursor = '\0';
                        TTFSurface* surface = TTFSurfaceCacheGetOrAdd(font, buffer);
                        if (surface == nullptr)
                            return false;
                        const int32_t cellWidthPx = GetCellPixelWidth(cell);
                        const int32_t glyphWidth = surface->w + (cell.bold ? 1 : 0);
                        return glyphWidth > cellWidthPx || surface->h > _cellHeight;
                    };

                    if (mayOverhang(currentCell) || mayOverhang(previousCell))
                    {
                        forceRowDraw = true;
                    }
                }
#endif

                markDirty(col);
                if (currentCell.wide || previousCell.wide)
                {
                    markDirty(col + 1);
                }
                if (currentCell.continuation || previousCell.continuation)
                {
                    markDirty(col - 1);
                }
            }

            auto rowOrigin = origin + ScreenCoordsXY{ 0, row * _cellHeight };
            std::span<const TerminalCell> rowSpan{ cells.data() + rowOffset, rowStride };

            if (forceRowDraw)
            {
                DrawRowCells(rt, rowOrigin, rowSpan);
                continue;
            }

            if (dirtyCount > cols / 2)
            {
                DrawRowCells(rt, rowOrigin, rowSpan);
                continue;
            }

            for (int32_t col = 0; col < cols; col++)
            {
                if (_dirtyMaskScratch[static_cast<size_t>(col)] == 0)
                {
                    continue;
                }
                DrawCellAt(rt, rowOrigin, col, rowSpan[static_cast<size_t>(col)]);
            }
        }

        const int32_t rowsPixelHeight = rows * _cellHeight;
        if (contentHeight > rowsPixelHeight)
        {
            const ScreenCoordsXY gapTopLeft = origin + ScreenCoordsXY{ 0, rowsPixelHeight };
            const ScreenCoordsXY gapBottomRight = origin + ScreenCoordsXY{ contentWidth - 1, contentHeight - 1 };
            Rect::fill(rt, { gapTopLeft, gapBottomRight }, ColourMapA[COLOUR_BLACK].mid_dark);
        }

        DrawStatusOverlay(rt, origin, contentWidth, contentHeight, lines);
        _renderedCells = cells;
        _renderedCols = cols;
        _renderedRows = rows;
    }

    void AIAgentTerminalWindow::DrawStatusOverlay(
        RenderTarget& rt, const ScreenCoordsXY& origin, int32_t canvasWidth, int32_t canvasHeight,
        const std::vector<std::string>& lines) const
    {
        if (lines.empty())
        {
            return;
        }

        // Use a smaller height for the status bar (about 70% of cell height)
        const int32_t statusLineHeight = (_cellHeight * 7) / 10;
        const int32_t textHeight = FontGetLineHeight(_fontStyle);
        const int32_t overlayHeight = static_cast<int32_t>(lines.size()) * statusLineHeight;
        ScreenCoordsXY topLeft = origin + ScreenCoordsXY{ 0, canvasHeight - overlayHeight };
        ScreenCoordsXY bottomRight = origin + ScreenCoordsXY{ canvasWidth - 1, canvasHeight - 1 };
        Rect::fill(rt, { topLeft, bottomRight }, ColourMapA[COLOUR_GREY].mid_dark);

        ScreenCoordsXY linePos = topLeft;
        for (const auto& line : lines)
        {
            // Center text vertically within the status line
            int32_t verticalOffset = (statusLineHeight - textHeight) / 2;
            DrawText(rt, linePos + ScreenCoordsXY{ 0, verticalOffset }, { COLOUR_WHITE, _fontStyle }, line.c_str(), true);
            linePos.y += statusLineHeight;
        }
    }

    void AIAgentTerminalWindow::DrawSidebar(RenderTarget& rt, const Widget& widget) const
    {
        ScreenCoordsXY topLeft = windowPos + ScreenCoordsXY{ widget.left, widget.top };
        ScreenCoordsXY bottomRight = windowPos + ScreenCoordsXY{ widget.right, widget.bottom };
        if (topLeft.x >= bottomRight.x || topLeft.y >= bottomRight.y)
            return;

        Rect::fill(rt, { topLeft, bottomRight }, ColourMapA[colours[1].colour].mid_dark);
        Rect::fillInset(
            rt,
            { topLeft, bottomRight },
            colours[1],
            Rect::BorderStyle::inset,
            Rect::FillBrightness::dark,
            Rect::FillMode::dontLightenWhenInset);
    }

    void AIAgentTerminalWindow::ClearTextInputBuffer() const
    {
        auto* session = const_cast<TextInputSession*>(GetTextboxSession());
        if (session != nullptr && session->Buffer != nullptr)
        {
            session->Buffer->clear();
            session->Length = 0;
            session->SelectionStart = 0;
            session->SelectionSize = 0;
        }
    }

    std::string AIAgentTerminalWindow::BuildKeySequence(const InputEvent& e) const
    {
        bool ctrl = (e.modifiers & KMOD_CTRL) != 0;
        bool alt = (e.modifiers & KMOD_ALT) != 0;
        bool gui = (e.modifiers & KMOD_GUI) != 0;
        bool shift = (e.modifiers & KMOD_SHIFT) != 0;

        auto sendArrow = [](const char* seq) {
            return std::string(seq);
        };

        switch (e.button)
        {
            case SDLK_RETURN:
                return "\r";
            case SDLK_BACKSPACE:
                return "\x7f";
            case SDLK_ESCAPE:
                return "\x1b";
            case SDLK_TAB:
                if (shift)
                    return std::string("\x1b[Z"); // Shift+Tab (backtab)
                return alt ? std::string("\x1b\t") : std::string("\t");
            case SDLK_LEFT:
                return sendArrow("\x1b[D");
            case SDLK_RIGHT:
                return sendArrow("\x1b[C");
            case SDLK_UP:
                return sendArrow("\x1b[A");
            case SDLK_DOWN:
                return sendArrow("\x1b[B");
            case SDLK_HOME:
                return sendArrow("\x1b[H");
            case SDLK_END:
                return sendArrow("\x1b[F");
            case SDLK_DELETE:
                return sendArrow("\x1b[3~");
            case SDLK_INSERT:
                return sendArrow("\x1b[2~");
            case SDLK_PAGEUP:
                return sendArrow("\x1b[5~");
            case SDLK_PAGEDOWN:
                return sendArrow("\x1b[6~");
            default:
                break;
        }

        if ((ctrl || gui) && !alt && e.button == SDLK_v)
        {
            if (auto clip = GetClipboardText(); !clip.empty())
            {
                return clip;
            }
            return {};
        }

        if (ctrl && !alt)
        {
            if (e.button >= SDLK_a && e.button <= SDLK_z)
            {
                char ch = static_cast<char>(e.button - SDLK_a + 1);
                return std::string(1, ch);
            }
            if (e.button == SDLK_SPACE)
            {
                return std::string(1, static_cast<char>(0));
            }
        }

        if (!ctrl && alt)
        {
            if (e.button >= SDLK_a && e.button <= SDLK_z)
            {
                char ch = static_cast<char>(e.button);
                if (std::isalpha(static_cast<unsigned char>(ch)))
                {
                    return std::string("\x1b") + static_cast<char>(ch);
                }
            }
        }

        if (!ctrl && !alt && !_textInputWorking)
        {
            if (auto ch = MapPrintableKey(e))
            {
                return std::string(1, *ch);
            }
        }

        return {};
    }

    bool AIAgentTerminalWindow::TryHandleClipboardPasteFallback(const InputEvent& e)
    {
        if (!_shellProcess)
            return false;

        if (e.button != SDLK_v)
            return false;

        bool ctrl = (e.modifiers & KMOD_CTRL) != 0;
        bool alt = (e.modifiers & KMOD_ALT) != 0;
        bool gui = (e.modifiers & KMOD_GUI) != 0;
        if (ctrl || alt || gui)
            return false;

        if (!_pendingPasteFallback)
            return false;

        auto clip = GetClipboardText();
        if (clip.empty())
        {
            _pendingPasteFallback = false;
            return false;
        }

        // Flow dictation sometimes releases Command before emitting 'v', so treat the lone 'v'
        // that follows a modifier+clipboard action as a paste request and inject the clipboard.
        _shellProcess->Write(clip);
        ClearTextInputBuffer();
        _lastPasteModifierTick = 0;
        _pendingPasteFallback = false;
        return true;
    }

    void AIAgentTerminalWindow::ResumeAutoFollow()
    {
        _pendingWheelPx = 0.0;
        SnapScrollToTail();
        invalidateWidget(WIDX_TERMINAL_CANVAS);
    }

    void AIAgentTerminalWindow::ScrollByRows(int deltaRows)
    {
        if (deltaRows == 0)
            return;

        // Scroll lock enforcement: refuse any scroll operations when locked
        if (_scrollLockEnabled)
            return;

        const int32_t totalRows = GetTotalRowCount();
        const int32_t maxHead = std::max<int32_t>(0, totalRows - _visibleRows);
        const int32_t nextHead = std::clamp(_scrollHeadRow - deltaRows, 0, maxHead);
        if (nextHead != _scrollHeadRow)
        {
            _scrollHeadRow = nextHead;
            _needsFullRedraw = true;
            _renderedCells.clear();
            _renderedCols = 0;
            _renderedRows = 0;
        }
        _autoFollowEnabled = (_scrollHeadRow >= maxHead);
        invalidateWidget(WIDX_TERMINAL_CANVAS);
    }

    void AIAgentTerminalWindow::ClampScrollHead()
    {
        const int32_t totalRows = GetTotalRowCount();
        const int32_t maxHead = std::max<int32_t>(0, totalRows - _visibleRows);

        // Scroll lock enforcement: always pin to tail when locked
        if (_scrollLockEnabled)
        {
            _scrollHeadRow = maxHead;
        }
        else
        {
            _scrollHeadRow = std::clamp(_scrollHeadRow, 0, maxHead);
        }
        _autoFollowEnabled = (_scrollHeadRow >= maxHead);
    }

    void AIAgentTerminalWindow::SnapScrollToTail()
    {
        const int32_t totalRows = GetTotalRowCount();
        const int32_t maxHead = std::max<int32_t>(0, totalRows - _visibleRows);
        _scrollHeadRow = maxHead;
        _autoFollowEnabled = true;
    }

    void AIAgentTerminalWindow::EnforceScrollLock()
    {
        // Robust scroll lock enforcement: called every frame when scroll lock is active
        // This is the final safety net - if scroll position somehow drifted,
        // this will correct it immediately
        const int32_t totalRows = GetTotalRowCount();
        const int32_t maxHead = std::max<int32_t>(0, totalRows - _visibleRows);

        if (_scrollHeadRow != maxHead)
        {
            _scrollHeadRow = maxHead;
            _pendingWheelPx = 0.0; // Clear any accumulated wheel delta
        }
    }

    int32_t AIAgentTerminalWindow::GetScrollbackRowCount() const
    {
        if (_scrollLockEnabled || _altScreenActive)
        {
            return 0;
        }
        return _terminalSession ? _terminalSession->GetScrollbackRowCount() : 0;
    }

    int32_t AIAgentTerminalWindow::GetTotalRowCount() const
    {
        const int32_t screenRows = _hasSnapshot ? _snapshot.rows : 0;
        return GetScrollbackRowCount() + screenRows;
    }

    void AIAgentTerminalWindow::CopyRowIntoBuffer(int rowIndex, std::vector<TerminalCell>& out) const
    {
        const int32_t cols = _snapshot.cols;
        if (rowIndex < 0 || cols <= 0)
        {
            out.clear();
            return;
        }

        const int32_t scrollbackRows = GetScrollbackRowCount();
        if (_terminalSession && rowIndex < scrollbackRows)
        {
            _terminalSession->CopyScrollbackRows(rowIndex, 1, out);
            return;
        }

        out.resize(static_cast<size_t>(cols), MakeBlankTerminalCell());
        if (!_hasSnapshot)
        {
            return;
        }

        const int32_t snapshotRow = rowIndex - scrollbackRows;
        if (snapshotRow < 0 || snapshotRow >= _snapshot.rows)
        {
            return;
        }

        const auto* src = &_snapshot.cells[static_cast<size_t>(snapshotRow) * cols];
        std::copy_n(src, cols, out.begin());
    }

    bool AIAgentTerminalWindow::IsPrintableAscii(char ch)
    {
        return ch >= 32 && ch < 127;
    }

    bool AIAgentTerminalHandleInput(const InputEvent& e)
    {
        if (sAIAgentTerminalInstance == nullptr)
            return false;
        if (!sAIAgentTerminalInstance->WantsKeyboardCapture())
            return false;
        return sAIAgentTerminalInstance->HandleKeyboardEvent(e);
    }

    void AIAgentTerminalWindow::LoadAutoplayPrompts()
    {
        _autoplayPrompts.clear();
        _autoplayPromptIndex = 0;

        // Try to load from workspace auto_prompts.txt
        const char* home = std::getenv("HOME");
        if (!home || !*home)
        {
            return;
        }
        auto promptsPath = (std::filesystem::path(home) / ".openrct2-agent" / "auto_prompts.txt").string();

        std::ifstream file(promptsPath);
        if (file.is_open())
        {
            std::string line;
            while (std::getline(file, line))
            {
                // Skip empty lines and comments
                if (line.empty() || line[0] == '#')
                    continue;
                // Trim whitespace
                size_t start = line.find_first_not_of(" \t");
                size_t end = line.find_last_not_of(" \t");
                if (start != std::string::npos && end != std::string::npos)
                {
                    _autoplayPrompts.push_back(line.substr(start, end - start + 1));
                }
            }
        }

        if (_autoplayPrompts.empty())
        {
            // Default prompts if file not found or empty
            _autoplayPrompts = {
                "Check the park status and address any urgent issues.",
                "Review guest feedback and make improvements.",
                "Check ride performance and optimize if needed.",
            };
        }

        LOG_INFO("Loaded %zu auto-play prompts", _autoplayPrompts.size());
    }

    void AIAgentTerminalWindow::SendNextAutoplayPrompt()
    {
        if (_autoplayPrompts.empty() || !_shellProcess || !_shellProcess->IsRunning())
            return;

        // Reset session monitor to track new turn
        if (_sessionMonitor)
        {
            _sessionMonitor->Reset();
        }

        const auto& prompt = _autoplayPrompts[_autoplayPromptIndex % _autoplayPrompts.size()];
        // Note: _autoplayPromptIndex is NOT incremented here - it advances when turn completes

        LOG_INFO("Auto-play sending prompt %zu: %.50s...", _autoplayPromptIndex, prompt.c_str());

        // Send the prompt text now
        bool textWriteOk = _shellProcess->Write(prompt);
        LOG_INFO("Auto-play Write(): text=%s, prompt_len=%zu (Enter will be sent after delay)",
            textWriteOk ? "ok" : "FAIL", prompt.size());

        // Schedule Enter key to be sent after a short delay (5 frames = ~83ms at 60fps)
        // This mimics the natural delay between typing and pressing Enter
        _autoplayPendingEnter = true;
        _autoplayEnterDelayFrames = 5;
    }

    void AIAgentTerminalWindow::UpdatePromptQueueBounds()
    {
        if (!_autoplayEnabled)
            return;

        auto& promptWidget = widgets[WIDX_PROMPT_QUEUE];
        promptWidget.left = 4;
        promptWidget.right = static_cast<int16_t>(width - 4);
        promptWidget.top = static_cast<int16_t>(height - kPromptQueuePanelHeight);
        promptWidget.bottom = static_cast<int16_t>(height - 4);
    }

    void AIAgentTerminalWindow::DrawPromptQueue(RenderTarget& rt)
    {
        if (_autoplayPrompts.empty())
            return;

        const auto& widget = widgets[WIDX_PROMPT_QUEUE];
        ScreenCoordsXY topLeft = windowPos + ScreenCoordsXY{ widget.left, widget.top };
        ScreenCoordsXY bottomRight = windowPos + ScreenCoordsXY{ widget.right, widget.bottom };

        if (topLeft.x >= bottomRight.x || topLeft.y >= bottomRight.y)
            return;

        // Draw panel background
        Rect::fill(rt, { topLeft, bottomRight }, ColourMapA[colours[1].colour].mid_dark);
        Rect::fillInset(
            rt,
            { topLeft, bottomRight },
            colours[1],
            Rect::BorderStyle::inset,
            Rect::FillBrightness::dark,
            Rect::FillMode::dontLightenWhenInset);

        // Draw prompts
        const int32_t textPadding = kPromptQueuePadding;
        ScreenCoordsXY linePos = topLeft + ScreenCoordsXY{ textPadding + 16, textPadding };

        for (int32_t i = 0; i < kPromptQueueVisibleCount; ++i)
        {
            const size_t promptIdx = (_autoplayPromptIndex + i) % _autoplayPrompts.size();
            const auto& prompt = _autoplayPrompts[promptIdx];

            // Current prompt indicator
            if (i == 0)
            {
                ScreenCoordsXY indicatorPos = topLeft + ScreenCoordsXY{ textPadding + 2, textPadding + (kPromptQueueRowHeight - 10) / 2 - 6 };
                DrawText(rt, indicatorPos, { COLOUR_BRIGHT_GREEN, FontStyle::medium }, "\xE2\x96\xB6", true); // ▶
            }

            // Truncate long prompts
            std::string displayText = prompt;
            if (displayText.length() > 108)
            {
                displayText = displayText.substr(0, 105) + "...";
            }

            // Draw prompt text (dimmer for upcoming prompts)
            colour_t textColour = (i == 0) ? COLOUR_WHITE : COLOUR_GREY;
            DrawText(rt, linePos, { textColour, FontStyle::medium }, displayText.c_str(), true);

            // Draw status indicator for current prompt (right-aligned)
            if (i == 0)
            {
                std::string statusText;
                colour_t statusColour;

                if (_autoplayDelayFrames > 0)
                {
                    // Countdown to next prompt
                    int32_t seconds = (_autoplayDelayFrames + 39) / 40; // Round up (40 ticks/sec)
                    statusText = "[" + std::to_string(seconds) + "s]";
                    statusColour = COLOUR_LIGHT_BLUE;
                }
                else if (_autoplayWaitingForResponse || _autoplayPendingEnter)
                {
                    // Waiting for Claude to finish working
                    statusText = "Working...";
                    statusColour = COLOUR_YELLOW;
                }
                else
                {
                    // About to send (brief flash)
                    statusText = "Sending!";
                    statusColour = COLOUR_BRIGHT_GREEN;
                }

                // Draw right-aligned (estimate ~8px per character for medium font)
                int32_t panelWidth = widget.right - widget.left;
                int32_t statusWidth = static_cast<int32_t>(statusText.length()) * 8;
                ScreenCoordsXY statusPos = topLeft + ScreenCoordsXY{
                    panelWidth - textPadding - statusWidth,
                    textPadding
                };
                DrawText(rt, statusPos, { statusColour, FontStyle::medium }, statusText.c_str(), true);
            }

            linePos.y += kPromptQueueRowHeight;
        }
    }

    void AIAgentTerminalWindow::ToggleAutoplay()
    {
        _autoplayEnabled = !_autoplayEnabled;
        _autoplayWaitingForResponse = false;
        // Add a short initial delay (2 seconds) when enabling autoplay to let Claude settle
        _autoplayDelayFrames = _autoplayEnabled ? 80 : 0; // 80 ticks at 40 ticks/sec = 2 seconds

        // Show/hide prompt queue widget
        widgets[WIDX_PROMPT_QUEUE].flags.set(WidgetFlag::isHidden, !_autoplayEnabled);

        // Update size constraints for new mode
        ApplySizeConstraints();

        // Resize window to accommodate/remove prompt panel
        const int16_t deltaHeight = _autoplayEnabled
            ? static_cast<int16_t>(kPromptQueuePanelHeight)
            : static_cast<int16_t>(-kPromptQueuePanelHeight);
        OpenRCT2::Ui::Windows::WindowResizeByDelta(*this, 0, deltaHeight);

        // Update widget positions for new size
        UpdatePromptQueueBounds();

        if (_autoplayEnabled)
        {
            _statusMessage = "Auto-play enabled";
            _statusMessageTimeout = kStatusMessageTimeoutFrames;
            // Initialize session monitor for turn detection
            InitializeSessionMonitor();
            // Reload prompts in case file changed
            LoadAutoplayPrompts();
        }
        else
        {
            _statusMessage = "Auto-play disabled";
            _statusMessageTimeout = kStatusMessageTimeoutFrames;
            // Release session monitor when autoplay is disabled
            _sessionMonitor.reset();
        }

        invalidate();
        _needsFullRedraw = true;
    }

    void AIAgentTerminalWindow::SetViewportLock(bool enabled)
    {
        auto* mainWindow = WindowGetMain();
        if (mainWindow != nullptr)
        {
            if (enabled)
            {
                mainWindow->flags.set(WindowFlag::noScrolling);
            }
            else
            {
                mainWindow->flags.unset(WindowFlag::noScrolling);
            }
        }
    }

    void AIAgentTerminalWindow::InitializeSessionMonitor()
    {
        // Get the workspace path that Claude is running in
        const char* home = std::getenv("HOME");
        if (!home || !*home)
        {
            LOG_WARNING("Auto-play: Cannot initialize session monitor - HOME not set");
            return;
        }
        auto workspacePath = std::filesystem::path(home) / ".openrct2-agent";

        // Create session monitor to watch Claude's JSONL session files
        _sessionMonitor = std::make_unique<OpenRCT2::Terminal::SessionFileMonitor>(workspacePath);

        // Prepare for discovery - snapshot all current files so we can detect which
        // one changes when we send our first prompt (identifies our agent's session)
        _sessionMonitor->PrepareForDiscovery();

        LOG_INFO("Auto-play: Session monitor initialized, ready to discover agent session file");
    }

    void AIAgentTerminalWindow::GenerateSessionLog()
    {
        if (_workspacePath.empty())
        {
            LOG_INFO("SessionLog: No workspace path set, skipping log generation");
            return;
        }

        // Get the current park name for the log filename
        std::string parkName;
        try
        {
            parkName = OpenRCT2::getGameState().park.name;
        }
        catch (...)
        {
            parkName = "Unknown";
        }

        // Get the specific session file from the monitor (if available)
        // This ensures we only log the current Claude conversation, not all history
        std::optional<std::filesystem::path> sessionFile;
        if (_sessionMonitor)
        {
            sessionFile = _sessionMonitor->GetSessionFilePath();
            if (sessionFile)
            {
                LOG_INFO("SessionLog: Using specific session file: %s", sessionFile->string().c_str());
            }
        }

        LOG_INFO("SessionLog: Generating session log for park '%s'", parkName.c_str());

        auto result = SessionLogGenerator::GenerateLog(_workspacePath, parkName, sessionFile);
        if (result.success)
        {
            LOG_INFO("SessionLog: Markdown saved to %s", result.markdownPath.string().c_str());
            if (!result.htmlPath.empty())
            {
                LOG_INFO("SessionLog: HTML saved to %s", result.htmlPath.string().c_str());
            }
            _statusMessage = "Session log saved";
        }
        else
        {
            LOG_WARNING("SessionLog: Failed to generate: %s", result.error.c_str());
        }
    }

    void AIAgentTerminalWindow::CheckForClearCommand(std::string_view text)
    {
        for (char c : text)
        {
            if (c == '\r' || c == '\n')
            {
                // Check if buffer contains /clear
                if (_inputBuffer == "/clear")
                {
                    LOG_INFO("SessionLog: /clear command detected, generating log snapshot");
                    GenerateSessionLog();
                }
                _inputBuffer.clear();
            }
            else if (c == '\x7f' || c == '\b')
            {
                // Backspace - remove last character
                if (!_inputBuffer.empty())
                {
                    _inputBuffer.pop_back();
                }
            }
            else if (c >= 32 && c < 127)
            {
                // Printable ASCII - add to buffer
                _inputBuffer += c;
                // Limit buffer size to prevent memory issues
                if (_inputBuffer.size() > 64)
                {
                    _inputBuffer.clear();
                }
            }
        }
    }

    WindowBase* AIAgentTerminalOpen()
    {
        auto* windowMgr = GetWindowManager();
        return windowMgr->FocusOrCreate<AIAgentTerminalWindow>(
            WindowClass::aiAgentTerminal, kAgentWindowSize,
            { WindowFlag::resizable, WindowFlag::autoPosition, WindowFlag::higherContrastOnPress, WindowFlag::noPush });
    }
} // namespace OpenRCT2::Ui::Windows
