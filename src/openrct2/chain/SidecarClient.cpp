/*****************************************************************************
 * Copyright (c) 2014-2025 OpenRCT2 developers
 *
 * For a complete list of all authors, please refer to contributors.md
 * Interested in contributing? Visit https://github.com/OpenRCT2/OpenRCT2
 *
 * OpenRCT2 is licensed under the GNU General Public License version 3.
 *****************************************************************************/

#ifdef OPENRCT2_CHAIN

    #include "SidecarClient.h"

    #include "../core/Json.hpp"
    #include "Runtime.h"

    #include <algorithm>
    #include <atomic>
    #include <cerrno>
    #include <cstring>
    #include <ctime>
    #include <poll.h>
    #include <string>
    #include <sys/socket.h>
    #include <sys/un.h>
    #include <unistd.h>

    // MSG_NOSIGNAL is universally defined on Linux and on modern macOS / *BSD;
    // fall back to 0 on platforms that lack it (callers can SO_NOSIGPIPE if needed).
    #ifndef MSG_NOSIGNAL
        #define MSG_NOSIGNAL 0
    #endif

namespace OpenRCT2::Chain::SidecarClient
{
    namespace
    {
        // Monotonically increasing request id. The sidecar echoes it back in the
        // response — we don't validate, since this is a one-shot connection per
        // call so there's no demux to do.
        std::atomic<uint64_t> gNextId{ 1 };

        // RAII wrapper to make sure we always close() the socket on any return path.
        struct ScopedFd
        {
            int fd = -1;
            ~ScopedFd()
            {
                if (fd >= 0)
                    ::close(fd);
            }
        };

        // poll() one fd for `events` until either it fires or `deadlineMs - now` elapses.
        // Returns true if the event fired before the deadline; false on timeout / error.
        bool WaitFd(int fd, short events, int remainingMs)
        {
            if (remainingMs <= 0)
                return false;
            pollfd pfd{};
            pfd.fd = fd;
            pfd.events = events;
            for (;;)
            {
                int rc = ::poll(&pfd, 1, remainingMs);
                if (rc > 0)
                    return (pfd.revents & (events | POLLERR | POLLHUP)) != 0;
                if (rc == 0)
                    return false;
                if (errno == EINTR)
                    continue;
                return false;
            }
        }

        int64_t NowMs()
        {
            timespec ts{};
            clock_gettime(CLOCK_MONOTONIC, &ts);
            return static_cast<int64_t>(ts.tv_sec) * 1000 + ts.tv_nsec / 1'000'000;
        }
    } // namespace

    bool Call(std::string_view method, const json_t& params, json_t& result, int timeoutMs)
    {
        const auto socketPath = GetSidecarSocketPath();
        if (socketPath.empty())
            return false;

        // sun_path on Linux/macOS is bounded; reject paths that would be silently truncated.
        sockaddr_un addr{};
        addr.sun_family = AF_UNIX;
        if (socketPath.size() + 1 > sizeof(addr.sun_path))
            return false;
        std::memcpy(addr.sun_path, socketPath.data(), socketPath.size());

        ScopedFd sock;
        sock.fd = ::socket(AF_UNIX, SOCK_STREAM, 0);
        if (sock.fd < 0)
            return false;

        const auto deadline = NowMs() + std::max(0, timeoutMs);
        auto remaining = [&]() { return static_cast<int>(std::max<int64_t>(0, deadline - NowMs())); };

        if (::connect(sock.fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0)
            return false;

        // Build the JSON-RPC request. Single-line framing — sidecar's parser splits on '\n'.
        json_t request = {
            { "jsonrpc", "2.0" },
            { "id", gNextId.fetch_add(1, std::memory_order_relaxed) },
            { "method", std::string(method) },
            { "params", params },
        };
        std::string line = request.dump();
        line.push_back('\n');

        size_t sent = 0;
        while (sent < line.size())
        {
            if (!WaitFd(sock.fd, POLLOUT, remaining()))
                return false;
            ssize_t n = ::send(sock.fd, line.data() + sent, line.size() - sent, MSG_NOSIGNAL);
            if (n <= 0)
            {
                if (n < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK))
                    continue;
                return false;
            }
            sent += static_cast<size_t>(n);
        }

        // Read until newline. Cap response size — protects against a runaway / hostile
        // sidecar from filling memory; real responses for guest.address / chain.venues.get
        // are well under 1 KiB.
        std::string buf;
        constexpr size_t kMaxResponseBytes = 64 * 1024;
        char chunk[1024];
        for (;;)
        {
            if (!WaitFd(sock.fd, POLLIN, remaining()))
                return false;
            ssize_t n = ::recv(sock.fd, chunk, sizeof(chunk), 0);
            if (n == 0)
                return false; // peer closed before we got a newline
            if (n < 0)
            {
                if (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)
                    continue;
                return false;
            }
            buf.append(chunk, static_cast<size_t>(n));
            if (buf.find('\n') != std::string::npos)
                break;
            if (buf.size() > kMaxResponseBytes)
                return false;
        }

        try
        {
            const auto nlPos = buf.find('\n');
            const auto response = json_t::parse(buf.substr(0, nlPos));
            if (!response.is_object())
                return false;
            if (response.contains("error"))
                return false;
            if (!response.contains("result"))
                return false;
            result = response["result"];
            return true;
        }
        catch (const json_t::exception&)
        {
            return false;
        }
    }
} // namespace OpenRCT2::Chain::SidecarClient

#endif // OPENRCT2_CHAIN
