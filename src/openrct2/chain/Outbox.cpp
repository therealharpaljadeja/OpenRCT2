/*****************************************************************************
 * Copyright (c) 2014-2025 OpenRCT2 developers
 *
 * For a complete list of all authors, please refer to contributors.md
 * Interested in contributing? Visit https://github.com/OpenRCT2/OpenRCT2
 *
 * OpenRCT2 is licensed under the GNU General Public License version 3.
 *****************************************************************************/

#ifdef OPENRCT2_CHAIN

    #include "Outbox.h"

    #include "../Diagnostic.h"

    #include <atomic>
    #include <chrono>
    #include <cstdio>
    #include <cstring>
    #include <filesystem>
    #include <memory>
    #include <mutex>
    #include <string>
    #include <system_error>
    #include <thread>
    #include <unordered_set>
    #include <utility>

namespace OpenRCT2::Chain
{
    namespace
    {
        // Wire-format constants — these strings are written verbatim into the WAL and must
        // match `chain-sidecar/src/outbox/types.ts::parseEvent`.
        constexpr const char* kKindGuestEntry = "GUEST_ENTRY";
        constexpr const char* kKindGuestSpend = "GUEST_SPEND";
        constexpr const char* kKindGuestExit = "GUEST_EXIT";
        constexpr const char* kKindVenueRegistered = "VENUE_REGISTERED";
        constexpr const char* kKindVenueRenamed = "VENUE_RENAMED";
        constexpr const char* kKindVenueRemoved = "VENUE_REMOVED";

        // Posix guarantees atomic O_APPEND writes ≤ PIPE_BUF (4096 on Linux). Cap the line
        // serializer's stack buffer to fit; truncate strings as needed to stay under.
        constexpr std::size_t kLineBufferSize = 4096;
        constexpr std::size_t kMaxNameBytes = 64;
        constexpr std::size_t kMaxObjectTypeBytes = 32;
        constexpr int kWriterIdleSleepMs = 10;

        // Round up to next power of two. Returns 1 for n == 0.
        std::size_t RoundUpPow2(std::size_t n)
        {
            if (n <= 1)
                return 1;
            --n;
            for (std::size_t i = 1; i < sizeof(n) * 8; i <<= 1)
                n |= n >> i;
            return n + 1;
        }

        // Trim `len` down so it doesn't end in the middle of a UTF-8 sequence. Drops a
        // partial trailing multibyte char if it would extend past `len`. Keeps invalid
        // bytes as-is (the reader's StringDecoder tolerates them).
        std::size_t Utf8SafeLength(const char* s, std::size_t len)
        {
            if (len == 0)
                return 0;
            std::size_t i = len;
            while (i > 0 && (static_cast<uint8_t>(s[i - 1]) & 0xC0) == 0x80)
                --i;
            if (i == 0)
                return 0;
            uint8_t lead = static_cast<uint8_t>(s[i - 1]);
            std::size_t expected = 1;
            if ((lead & 0x80) == 0)
                expected = 1;
            else if ((lead & 0xE0) == 0xC0)
                expected = 2;
            else if ((lead & 0xF0) == 0xE0)
                expected = 3;
            else if ((lead & 0xF8) == 0xF0)
                expected = 4;
            if ((i - 1) + expected <= len)
                return (i - 1) + expected;
            return i - 1;
        }

        // Append a JSON string literal (with surrounding quotes) into `dst` at `*pos`.
        // Returns false if the buffer would overflow.
        bool AppendJsonString(char* dst, std::size_t cap, std::size_t* pos, const char* src, std::size_t srcLen)
        {
            if (*pos >= cap)
                return false;
            dst[(*pos)++] = '"';
            for (std::size_t i = 0; i < srcLen; ++i)
            {
                uint8_t c = static_cast<uint8_t>(src[i]);
                // Reserve up to 6 bytes (\u00XX) plus the closing quote + comma.
                if (*pos + 6 + 2 >= cap)
                    return false;
                switch (c)
                {
                    case '"':
                        dst[(*pos)++] = '\\';
                        dst[(*pos)++] = '"';
                        break;
                    case '\\':
                        dst[(*pos)++] = '\\';
                        dst[(*pos)++] = '\\';
                        break;
                    case '\b':
                        dst[(*pos)++] = '\\';
                        dst[(*pos)++] = 'b';
                        break;
                    case '\f':
                        dst[(*pos)++] = '\\';
                        dst[(*pos)++] = 'f';
                        break;
                    case '\n':
                        dst[(*pos)++] = '\\';
                        dst[(*pos)++] = 'n';
                        break;
                    case '\r':
                        dst[(*pos)++] = '\\';
                        dst[(*pos)++] = 'r';
                        break;
                    case '\t':
                        dst[(*pos)++] = '\\';
                        dst[(*pos)++] = 't';
                        break;
                    default:
                        if (c < 0x20)
                        {
                            int n = std::snprintf(dst + *pos, cap - *pos, "\\u%04X", c);
                            if (n < 0 || static_cast<std::size_t>(n) >= cap - *pos)
                                return false;
                            *pos += static_cast<std::size_t>(n);
                        }
                        else
                        {
                            dst[(*pos)++] = static_cast<char>(c);
                        }
                        break;
                }
            }
            if (*pos >= cap)
                return false;
            dst[(*pos)++] = '"';
            return true;
        }

        bool AppendLiteral(char* dst, std::size_t cap, std::size_t* pos, const char* src)
        {
            std::size_t n = std::strlen(src);
            if (*pos + n >= cap)
                return false;
            std::memcpy(dst + *pos, src, n);
            *pos += n;
            return true;
        }

        bool AppendUnsigned(char* dst, std::size_t cap, std::size_t* pos, uint64_t v)
        {
            int n = std::snprintf(dst + *pos, cap - *pos, "%llu", static_cast<unsigned long long>(v));
            if (n < 0 || static_cast<std::size_t>(n) >= cap - *pos)
                return false;
            *pos += static_cast<std::size_t>(n);
            return true;
        }

        bool AppendSigned(char* dst, std::size_t cap, std::size_t* pos, int64_t v)
        {
            int n = std::snprintf(dst + *pos, cap - *pos, "%lld", static_cast<long long>(v));
            if (n < 0 || static_cast<std::size_t>(n) >= cap - *pos)
                return false;
            *pos += static_cast<std::size_t>(n);
            return true;
        }

        // Internal record handed from producer to writer thread. Fixed-size POD so the SPSC
        // ring can copy slot-by-slot without allocations on the hot path.
        struct Record
        {
            enum class Kind : uint8_t
            {
                GuestEntry = 0,
                GuestSpend = 1,
                GuestExit = 2,
                VenueRegistered = 3,
                VenueRenamed = 4,
                VenueRemoved = 5,
            };

            uint64_t seq;
            uint64_t tsMs;
            Kind kind;
            uint8_t venueKind; // VENUE_REGISTERED only
            uint8_t category;  // GUEST_SPEND only
            uint8_t _pad;
            int32_t guestId;
            uint32_t hdIndex;
            uint32_t venueId;
            uint64_t amount;   // GUEST_ENTRY.cash or GUEST_SPEND.amount (wei)
            uint64_t gameTick; // GUEST_SPEND only
            uint16_t nameLen;
            uint16_t objectTypeLen;
            char name[kMaxNameBytes];
            char objectType[kMaxObjectTypeBytes];
        };

        // Lamport's SPSC ring. Indices grow without bound and are masked on slot access.
        // Acquire/release semantics across the head/tail pair give the slot publish ordering
        // without a full fence on the producer hot path.
        class SpscRing
        {
        public:
            explicit SpscRing(std::size_t capacityRequest)
                : _capacity(RoundUpPow2(capacityRequest == 0 ? 1 : capacityRequest))
                , _mask(_capacity - 1)
                , _slots(std::make_unique<Record[]>(_capacity))
            {
            }

            // Producer: copy `r` into the next slot. Returns false if the ring is full.
            bool TryPush(const Record& r)
            {
                const auto write = _writePos.load(std::memory_order_relaxed);
                const auto read = _readPos.load(std::memory_order_acquire);
                if (write - read >= _capacity)
                    return false;
                _slots[write & _mask] = r;
                _writePos.store(write + 1, std::memory_order_release);
                return true;
            }

            // Consumer: copy the next slot into `out`. Returns false if the ring is empty.
            bool TryPop(Record& out)
            {
                const auto read = _readPos.load(std::memory_order_relaxed);
                const auto write = _writePos.load(std::memory_order_acquire);
                if (read == write)
                    return false;
                out = _slots[read & _mask];
                _readPos.store(read + 1, std::memory_order_release);
                return true;
            }

            std::size_t Capacity() const
            {
                return _capacity;
            }

        private:
            const std::size_t _capacity;
            const std::size_t _mask;
            std::unique_ptr<Record[]> _slots;
            std::atomic<std::size_t> _writePos{ 0 };
            std::atomic<std::size_t> _readPos{ 0 };
        };

        // Find the highest valid `"seq":N` integer present in the file. Tolerates trailing
        // garbage / partial lines. O(file size) — only run once at Start().
        // Returns -1 when no seq is found (fresh WAL or unreadable file).
        int64_t ScanLastSeq(const std::string& path)
        {
            std::FILE* fp = std::fopen(path.c_str(), "rb");
            if (fp == nullptr)
                return -1;
            int64_t highest = -1;
            constexpr std::size_t kBuf = 16 * 1024;
            // We scan byte-by-byte for the literal token `"seq":` then read the digits.
            // Need an overlap window of `tokenLen - 1` so the token isn't split between
            // chunks. `prev` carries the last few bytes of each chunk.
            const char token[] = "\"seq\":";
            const std::size_t tokenLen = std::strlen(token);
            std::string buf;
            buf.resize(kBuf);
            std::string carry;
            while (!std::feof(fp))
            {
                std::size_t got = std::fread(buf.data(), 1, kBuf, fp);
                if (got == 0)
                    break;
                std::string scan = carry;
                scan.append(buf.data(), got);
                std::size_t i = 0;
                while (i + tokenLen < scan.size())
                {
                    if (std::memcmp(scan.data() + i, token, tokenLen) == 0)
                    {
                        std::size_t j = i + tokenLen;
                        uint64_t n = 0;
                        bool any = false;
                        while (j < scan.size() && scan[j] >= '0' && scan[j] <= '9')
                        {
                            n = n * 10 + static_cast<uint64_t>(scan[j] - '0');
                            ++j;
                            any = true;
                        }
                        if (any && static_cast<int64_t>(n) > highest)
                            highest = static_cast<int64_t>(n);
                        i = j;
                    }
                    else
                    {
                        ++i;
                    }
                }
                // Carry the trailing tokenLen-1 bytes so the token isn't split next chunk.
                if (scan.size() > tokenLen - 1)
                    carry.assign(scan.data() + scan.size() - (tokenLen - 1), tokenLen - 1);
                else
                    carry = scan;
            }
            std::fclose(fp);
            return highest;
        }

        uint64_t NowMs()
        {
            using namespace std::chrono;
            return static_cast<uint64_t>(duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count());
        }
    } // namespace

    struct Outbox::Impl
    {
        OutboxOptions opts;

        SpscRing ring;

        std::FILE* fp = nullptr;
        uint64_t currentSize = 0;

        std::thread writerThread;
        std::atomic<bool> stopWanted{ false };
        std::atomic<bool> running{ false };

        // Producer-only: monotonic seq + counters.
        std::atomic<uint64_t> nextSeq{ 0 };
        std::atomic<uint32_t> nextHdIndex{ 0 };
        std::atomic<uint64_t> pushed{ 0 };
        std::atomic<uint64_t> dropped{ 0 };

        // Writer-thread-only counters; published via atomics for stats reads.
        std::atomic<uint64_t> written{ 0 };
        std::atomic<uint64_t> bytesWritten{ 0 };
        std::atomic<uint64_t> rotations{ 0 };
        std::atomic<uint64_t> writeErrors{ 0 };

        // Producer-thread-only: venueIds with a live VENUE_REGISTERED that hasn't been paired
        // with a VENUE_REMOVED yet. Used to make Push{VenueRegistered,VenueRemoved} idempotent
        // so a placement that the agent attempts and rolls back doesn't produce a stray
        // register/remove pair on chain.
        std::unordered_set<uint32_t> announcedVenues;

        explicit Impl(OutboxOptions o)
            : opts(std::move(o))
            , ring(opts.ringCapacity)
        {
        }

        bool OpenFp()
        {
            std::error_code ec;
            std::filesystem::create_directories(std::filesystem::path(opts.walPath).parent_path(), ec);
            // ec ignored: directory may already exist or be the current dir.
            fp = std::fopen(opts.walPath.c_str(), "ab");
            if (fp == nullptr)
            {
                LOG_ERROR("chain.outbox: failed to open WAL '%s' for append", opts.walPath.c_str());
                return false;
            }
            // Unbuffered → each fwrite is one syscall; on POSIX, append-mode writes ≤ PIPE_BUF
            // are atomic, so a concurrent reader never sees torn lines.
            std::setvbuf(fp, nullptr, _IONBF, 0);

            // Pick up the existing file size for the rotation accounting.
            std::error_code sizeEc;
            auto sz = std::filesystem::file_size(opts.walPath, sizeEc);
            currentSize = sizeEc ? 0 : static_cast<uint64_t>(sz);
            return true;
        }

        void RotateInPlace()
        {
            if (fp != nullptr)
            {
                std::fclose(fp);
                fp = nullptr;
            }
            std::error_code ec;
            std::filesystem::resize_file(opts.walPath, 0, ec);
            if (ec)
            {
                LOG_ERROR("chain.outbox: failed to truncate WAL '%s': %s", opts.walPath.c_str(), ec.message().c_str());
            }
            fp = std::fopen(opts.walPath.c_str(), "ab");
            if (fp != nullptr)
            {
                std::setvbuf(fp, nullptr, _IONBF, 0);
            }
            currentSize = 0;
            rotations.fetch_add(1, std::memory_order_relaxed);
            LOG_WARNING(
                "chain.outbox: WAL '%s' truncated due to %llu-byte cap (rotation #%llu)", opts.walPath.c_str(),
                static_cast<unsigned long long>(opts.maxBytes),
                static_cast<unsigned long long>(rotations.load(std::memory_order_relaxed)));
        }

        // Serialize one record into `out`. Returns the number of bytes written, or 0 on
        // overflow. The buffer is sized so overflow only occurs from pathologically long
        // venue names — we truncate before push, so realistic events always fit.
        std::size_t Serialize(const Record& r, char* out, std::size_t cap)
        {
            std::size_t pos = 0;
            const auto kindStr = [&]() -> const char* {
                switch (r.kind)
                {
                    case Record::Kind::GuestEntry:
                        return kKindGuestEntry;
                    case Record::Kind::GuestSpend:
                        return kKindGuestSpend;
                    case Record::Kind::GuestExit:
                        return kKindGuestExit;
                    case Record::Kind::VenueRegistered:
                        return kKindVenueRegistered;
                    case Record::Kind::VenueRenamed:
                        return kKindVenueRenamed;
                    case Record::Kind::VenueRemoved:
                        return kKindVenueRemoved;
                }
                return "UNKNOWN";
            }();

            if (!AppendLiteral(out, cap, &pos, "{\"seq\":"))
                return 0;
            if (!AppendUnsigned(out, cap, &pos, r.seq))
                return 0;
            if (!AppendLiteral(out, cap, &pos, ",\"ts\":"))
                return 0;
            if (!AppendUnsigned(out, cap, &pos, r.tsMs))
                return 0;
            if (!AppendLiteral(out, cap, &pos, ",\"kind\":"))
                return 0;
            if (!AppendJsonString(out, cap, &pos, kindStr, std::strlen(kindStr)))
                return 0;

            switch (r.kind)
            {
                case Record::Kind::GuestEntry:
                    if (!AppendLiteral(out, cap, &pos, ",\"guestId\":"))
                        return 0;
                    if (!AppendSigned(out, cap, &pos, r.guestId))
                        return 0;
                    if (!AppendLiteral(out, cap, &pos, ",\"hdIndex\":"))
                        return 0;
                    if (!AppendUnsigned(out, cap, &pos, r.hdIndex))
                        return 0;
                    if (!AppendLiteral(out, cap, &pos, ",\"cash\":\""))
                        return 0;
                    if (!AppendUnsigned(out, cap, &pos, r.amount))
                        return 0;
                    if (!AppendLiteral(out, cap, &pos, "\""))
                        return 0;
                    break;
                case Record::Kind::GuestSpend:
                    if (!AppendLiteral(out, cap, &pos, ",\"guestId\":"))
                        return 0;
                    if (!AppendSigned(out, cap, &pos, r.guestId))
                        return 0;
                    if (!AppendLiteral(out, cap, &pos, ",\"hdIndex\":"))
                        return 0;
                    if (!AppendUnsigned(out, cap, &pos, r.hdIndex))
                        return 0;
                    if (!AppendLiteral(out, cap, &pos, ",\"venueId\":"))
                        return 0;
                    if (!AppendUnsigned(out, cap, &pos, r.venueId))
                        return 0;
                    if (!AppendLiteral(out, cap, &pos, ",\"amount\":\""))
                        return 0;
                    if (!AppendUnsigned(out, cap, &pos, r.amount))
                        return 0;
                    if (!AppendLiteral(out, cap, &pos, "\""))
                        return 0;
                    if (!AppendLiteral(out, cap, &pos, ",\"category\":"))
                        return 0;
                    if (!AppendUnsigned(out, cap, &pos, r.category))
                        return 0;
                    if (!AppendLiteral(out, cap, &pos, ",\"gameTick\":"))
                        return 0;
                    if (!AppendUnsigned(out, cap, &pos, r.gameTick))
                        return 0;
                    break;
                case Record::Kind::GuestExit:
                    if (!AppendLiteral(out, cap, &pos, ",\"guestId\":"))
                        return 0;
                    if (!AppendSigned(out, cap, &pos, r.guestId))
                        return 0;
                    if (!AppendLiteral(out, cap, &pos, ",\"hdIndex\":"))
                        return 0;
                    if (!AppendUnsigned(out, cap, &pos, r.hdIndex))
                        return 0;
                    break;
                case Record::Kind::VenueRegistered:
                    if (!AppendLiteral(out, cap, &pos, ",\"venueId\":"))
                        return 0;
                    if (!AppendUnsigned(out, cap, &pos, r.venueId))
                        return 0;
                    if (!AppendLiteral(out, cap, &pos, ",\"venueKind\":"))
                        return 0;
                    if (!AppendUnsigned(out, cap, &pos, r.venueKind))
                        return 0;
                    if (!AppendLiteral(out, cap, &pos, ",\"name\":"))
                        return 0;
                    if (!AppendJsonString(out, cap, &pos, r.name, r.nameLen))
                        return 0;
                    if (!AppendLiteral(out, cap, &pos, ",\"objectType\":"))
                        return 0;
                    if (!AppendJsonString(out, cap, &pos, r.objectType, r.objectTypeLen))
                        return 0;
                    break;
                case Record::Kind::VenueRenamed:
                    if (!AppendLiteral(out, cap, &pos, ",\"venueId\":"))
                        return 0;
                    if (!AppendUnsigned(out, cap, &pos, r.venueId))
                        return 0;
                    if (!AppendLiteral(out, cap, &pos, ",\"newName\":"))
                        return 0;
                    if (!AppendJsonString(out, cap, &pos, r.name, r.nameLen))
                        return 0;
                    break;
                case Record::Kind::VenueRemoved:
                    if (!AppendLiteral(out, cap, &pos, ",\"venueId\":"))
                        return 0;
                    if (!AppendUnsigned(out, cap, &pos, r.venueId))
                        return 0;
                    break;
            }

            if (pos + 2 >= cap)
                return 0;
            out[pos++] = '}';
            out[pos++] = '\n';
            return pos;
        }

        void WriteOne(const Record& r)
        {
            if (fp == nullptr)
            {
                writeErrors.fetch_add(1, std::memory_order_relaxed);
                return;
            }
            char line[kLineBufferSize];
            std::size_t lineLen = Serialize(r, line, sizeof(line));
            if (lineLen == 0)
            {
                writeErrors.fetch_add(1, std::memory_order_relaxed);
                LOG_WARNING("chain.outbox: serialization overflow for seq %llu kind %u — dropping",
                    static_cast<unsigned long long>(r.seq), static_cast<unsigned>(r.kind));
                return;
            }
            if (currentSize + lineLen > opts.maxBytes)
            {
                RotateInPlace();
                if (fp == nullptr)
                {
                    writeErrors.fetch_add(1, std::memory_order_relaxed);
                    return;
                }
            }
            std::size_t n = std::fwrite(line, 1, lineLen, fp);
            if (n != lineLen)
            {
                writeErrors.fetch_add(1, std::memory_order_relaxed);
                LOG_ERROR(
                    "chain.outbox: short write to '%s' (wrote %zu of %zu)", opts.walPath.c_str(), n, lineLen);
                return;
            }
            currentSize += lineLen;
            bytesWritten.fetch_add(lineLen, std::memory_order_relaxed);
            written.fetch_add(1, std::memory_order_relaxed);
        }

        void WriterLoop()
        {
            while (!stopWanted.load(std::memory_order_acquire))
            {
                Record r;
                bool any = false;
                while (ring.TryPop(r))
                {
                    WriteOne(r);
                    any = true;
                }
                if (!any)
                    std::this_thread::sleep_for(std::chrono::milliseconds(kWriterIdleSleepMs));
            }
            // Drain remaining records on shutdown — Stop() guarantees no producers run after
            // it returns, so the ring is fixed-size and the drain is bounded.
            Record r;
            while (ring.TryPop(r))
                WriteOne(r);
        }

        // Producer-side helper: stamp common fields, copy strings, push onto the ring.
        void Submit(Record& r, std::string_view name = {}, std::string_view objectType = {})
        {
            std::size_t nLen = name.size();
            if (nLen > kMaxNameBytes)
                nLen = kMaxNameBytes;
            nLen = Utf8SafeLength(name.data(), nLen);
            std::size_t oLen = objectType.size();
            if (oLen > kMaxObjectTypeBytes)
                oLen = kMaxObjectTypeBytes;
            oLen = Utf8SafeLength(objectType.data(), oLen);
            r.nameLen = static_cast<uint16_t>(nLen);
            r.objectTypeLen = static_cast<uint16_t>(oLen);
            if (nLen > 0)
                std::memcpy(r.name, name.data(), nLen);
            if (oLen > 0)
                std::memcpy(r.objectType, objectType.data(), oLen);
            r.tsMs = NowMs();
            r.seq = nextSeq.fetch_add(1, std::memory_order_relaxed);
            if (!ring.TryPush(r))
            {
                dropped.fetch_add(1, std::memory_order_relaxed);
                return;
            }
            pushed.fetch_add(1, std::memory_order_relaxed);
        }
    };

    Outbox::Outbox(OutboxOptions opts)
        : _impl(std::make_unique<Impl>(std::move(opts)))
    {
    }

    Outbox::~Outbox()
    {
        Stop();
    }

    bool Outbox::Start()
    {
        if (_impl->running.load())
            return true;
        if (!_impl->OpenFp())
            return false;
        int64_t lastSeq = ScanLastSeq(_impl->opts.walPath);
        _impl->nextSeq.store(lastSeq < 0 ? 0 : static_cast<uint64_t>(lastSeq) + 1, std::memory_order_relaxed);
        _impl->stopWanted.store(false, std::memory_order_release);
        _impl->running.store(true, std::memory_order_release);
        _impl->writerThread = std::thread([impl = _impl.get()] { impl->WriterLoop(); });
        LOG_INFO(
            "chain.outbox: started; wal='%s' nextSeq=%llu maxBytes=%llu ringCapacity=%zu",
            _impl->opts.walPath.c_str(),
            static_cast<unsigned long long>(_impl->nextSeq.load(std::memory_order_relaxed)),
            static_cast<unsigned long long>(_impl->opts.maxBytes), _impl->ring.Capacity());
        return true;
    }

    void Outbox::Stop()
    {
        if (!_impl->running.load())
            return;
        _impl->stopWanted.store(true, std::memory_order_release);
        if (_impl->writerThread.joinable())
            _impl->writerThread.join();
        if (_impl->fp != nullptr)
        {
            std::fclose(_impl->fp);
            _impl->fp = nullptr;
        }
        _impl->running.store(false, std::memory_order_release);
        LOG_INFO("chain.outbox: stopped; written=%llu dropped=%llu writeErrors=%llu",
            static_cast<unsigned long long>(_impl->written.load(std::memory_order_relaxed)),
            static_cast<unsigned long long>(_impl->dropped.load(std::memory_order_relaxed)),
            static_cast<unsigned long long>(_impl->writeErrors.load(std::memory_order_relaxed)));
    }

    uint32_t Outbox::AllocateHdIndex()
    {
        return _impl->nextHdIndex.fetch_add(1, std::memory_order_relaxed);
    }

    void Outbox::PushGuestEntry(int32_t guestId, uint32_t hdIndex, uint64_t cashWei)
    {
        Record r{};
        r.kind = Record::Kind::GuestEntry;
        r.guestId = guestId;
        r.hdIndex = hdIndex;
        r.amount = cashWei;
        _impl->Submit(r);
    }

    void Outbox::PushGuestSpend(
        int32_t guestId,
        uint32_t hdIndex,
        uint32_t venueId,
        uint64_t amountWei,
        SpendCategory category,
        uint64_t gameTick)
    {
        Record r{};
        r.kind = Record::Kind::GuestSpend;
        r.guestId = guestId;
        r.hdIndex = hdIndex;
        r.venueId = venueId;
        r.amount = amountWei;
        r.category = static_cast<uint8_t>(category);
        r.gameTick = gameTick;
        _impl->Submit(r);
    }

    void Outbox::PushGuestExit(int32_t guestId, uint32_t hdIndex)
    {
        Record r{};
        r.kind = Record::Kind::GuestExit;
        r.guestId = guestId;
        r.hdIndex = hdIndex;
        _impl->Submit(r);
    }

    void Outbox::PushVenueRegistered(uint32_t venueId, VenueKind kind, std::string_view name, std::string_view objectType)
    {
        if (!_impl->announcedVenues.insert(venueId).second)
            return;
        Record r{};
        r.kind = Record::Kind::VenueRegistered;
        r.venueId = venueId;
        r.venueKind = static_cast<uint8_t>(kind);
        _impl->Submit(r, name, objectType);
    }

    void Outbox::PushVenueRenamed(uint32_t venueId, std::string_view newName)
    {
        Record r{};
        r.kind = Record::Kind::VenueRenamed;
        r.venueId = venueId;
        _impl->Submit(r, newName);
    }

    void Outbox::PushVenueRemoved(uint32_t venueId)
    {
        if (_impl->announcedVenues.erase(venueId) == 0)
            return;
        Record r{};
        r.kind = Record::Kind::VenueRemoved;
        r.venueId = venueId;
        _impl->Submit(r);
    }

    OutboxStats Outbox::GetStats() const
    {
        return OutboxStats{
            _impl->pushed.load(std::memory_order_relaxed),
            _impl->written.load(std::memory_order_relaxed),
            _impl->dropped.load(std::memory_order_relaxed),
            _impl->bytesWritten.load(std::memory_order_relaxed),
            _impl->rotations.load(std::memory_order_relaxed),
            _impl->writeErrors.load(std::memory_order_relaxed),
            _impl->nextSeq.load(std::memory_order_relaxed),
            _impl->opts.walPath,
            _impl->running.load(std::memory_order_relaxed),
        };
    }

    namespace
    {
        std::mutex gOutboxMutex;
        std::unique_ptr<Outbox> gOutbox;
    } // namespace

    Outbox* GetOutbox()
    {
        std::lock_guard<std::mutex> lock(gOutboxMutex);
        return gOutbox.get();
    }

    void SetOutbox(std::unique_ptr<Outbox> outbox)
    {
        std::lock_guard<std::mutex> lock(gOutboxMutex);
        gOutbox = std::move(outbox);
    }
} // namespace OpenRCT2::Chain

#endif // OPENRCT2_CHAIN
