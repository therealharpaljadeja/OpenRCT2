#include "rctctl/rpc/json_rpc_client.hpp"

#include <stdexcept>
#include <string>
#include <utility>

#if defined(_WIN32)
    #define NOMINMAX
    #include <winsock2.h>
    #include <ws2tcpip.h>
#else
    #include <arpa/inet.h>
    #include <netdb.h>
    #include <netinet/in.h>
    #include <netinet/tcp.h>
    #include <sys/socket.h>
    #include <unistd.h>
#endif

namespace rctctl::rpc {
namespace {
#if defined(_WIN32)
class WinsockInitializer
{
public:
    WinsockInitializer()
    {
        WSADATA wsa;
        if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0)
        {
            throw std::runtime_error("Internal: WSAStartup failed");
        }
    }

    ~WinsockInitializer()
    {
        WSACleanup();
    }
};
#endif

#if defined(_WIN32)
    using SocketHandle = SOCKET;
    constexpr SocketHandle kInvalidSocket = INVALID_SOCKET;
#else
    using SocketHandle = int;
    constexpr SocketHandle kInvalidSocket = -1;
#endif

class TcpClient
{
public:
    TcpClient(std::string host, uint16_t port)
        : _host(std::move(host))
        , _port(port)
    {
    }

    ~TcpClient()
    {
        Close();
    }

    void Connect()
    {
#if defined(_WIN32)
        static WinsockInitializer winsockOnce;
#endif
        Close();

        auto portStr = std::to_string(_port);

        // Fast path: skip DNS resolution for numeric IPv4 addresses (common case: 127.0.0.1)
        sockaddr_in addr4{};
        if (inet_pton(AF_INET, _host.c_str(), &addr4.sin_addr) == 1)
        {
            addr4.sin_family = AF_INET;
            addr4.sin_port = htons(_port);

            SocketHandle candidate = ::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
            if (candidate != kInvalidSocket)
            {
                if (::connect(candidate, reinterpret_cast<sockaddr*>(&addr4), sizeof(addr4)) == 0)
                {
                    _socket = candidate;
                    SetSocketOptions();
                    return;
                }
                CloseSocket(candidate);
            }
            throw std::runtime_error("Internal: Unable to connect to " + _host + ":" + portStr);
        }

        // Slow path: DNS resolution needed for hostnames
        addrinfo hints{};
        hints.ai_family = AF_INET; // Prefer IPv4 for localhost connections
        hints.ai_socktype = SOCK_STREAM;
        hints.ai_protocol = IPPROTO_TCP;

        addrinfo* result = nullptr;
        const int rc = getaddrinfo(_host.c_str(), portStr.c_str(), &hints, &result);
        if (rc != 0)
        {
            throw std::runtime_error("Internal: Unable to resolve " + _host + ":" + portStr);
        }

        for (auto* ptr = result; ptr != nullptr; ptr = ptr->ai_next)
        {
            SocketHandle candidate = ::socket(ptr->ai_family, ptr->ai_socktype, ptr->ai_protocol);
            if (candidate == kInvalidSocket)
            {
                continue;
            }

            if (::connect(candidate, ptr->ai_addr, static_cast<int>(ptr->ai_addrlen)) == 0)
            {
                _socket = candidate;
                break;
            }

            CloseSocket(candidate);
        }

        freeaddrinfo(result);

        if (_socket == kInvalidSocket)
        {
            throw std::runtime_error("Internal: Unable to connect to " + _host + ":" + portStr);
        }

        SetSocketOptions();
    }

    void SetSocketOptions()
    {
        // Disable Nagle's algorithm to reduce latency for small RPC messages
        int flag = 1;
#if defined(_WIN32)
        setsockopt(_socket, IPPROTO_TCP, TCP_NODELAY, reinterpret_cast<const char*>(&flag), sizeof(flag));
#else
        setsockopt(_socket, IPPROTO_TCP, TCP_NODELAY, &flag, sizeof(flag));
#endif
    }

    void Send(const std::string& data)
    {
        EnsureConnected();
        size_t total = 0;
        while (total < data.size())
        {
#if defined(_WIN32)
            int sent = ::send(_socket, data.data() + total, static_cast<int>(data.size() - total), 0);
#else
            ssize_t sent = ::send(_socket, data.data() + total, data.size() - total, 0);
#endif
            if (sent <= 0)
            {
                throw std::runtime_error("Internal: Socket send failed");
            }
            total += static_cast<size_t>(sent);
        }
    }

    std::string ReceiveLine()
    {
        EnsureConnected();
        while (true)
        {
            auto newlinePos = _buffer.find('\n');
            if (newlinePos != std::string::npos)
            {
                std::string line = _buffer.substr(0, newlinePos);
                _buffer.erase(0, newlinePos + 1);
                if (!line.empty() && line.back() == '\r')
                {
                    line.pop_back();
                }
                return line;
            }

            char chunk[2048];
#if defined(_WIN32)
            int received = ::recv(_socket, chunk, sizeof(chunk), 0);
#else
            ssize_t received = ::recv(_socket, chunk, sizeof(chunk), 0);
#endif
            if (received <= 0)
            {
                throw std::runtime_error("Internal: Connection closed by server");
            }
            _buffer.append(chunk, received);
        }
    }

private:
    void EnsureConnected() const
    {
        if (_socket == kInvalidSocket)
        {
            throw std::runtime_error("Internal: Socket is not connected");
        }
    }

    void Close()
    {
        if (_socket != kInvalidSocket)
        {
            CloseSocket(_socket);
            _socket = kInvalidSocket;
        }
    }

    static void CloseSocket(SocketHandle sock)
    {
#if defined(_WIN32)
        closesocket(sock);
#else
        ::close(sock);
#endif
    }

    std::string _host;
    uint16_t _port;
    SocketHandle _socket = kInvalidSocket;
    std::string _buffer;
};

class JsonRpcClientImpl
{
public:
    JsonRpcClientImpl(std::string host, uint16_t port)
        : _connection(std::move(host), port)
    {
        _connection.Connect();
    }

    nlohmann::json Call(const std::string& method, const nlohmann::json& params)
    {
        nlohmann::json request = nlohmann::json::object();
        request["jsonrpc"] = "2.0";
        request["id"] = _nextId++;
        request["method"] = method;
        request["params"] = params;

        auto payload = request.dump();
        payload.push_back('\n');
        _connection.Send(payload);

        auto line = _connection.ReceiveLine();
        auto response = nlohmann::json::parse(line);
        if (response.contains("error") && !response["error"].is_null())
        {
            const auto& error = response["error"];
            auto message = error.value("message", std::string("Unknown error"));
            auto code = error.value("code", -32000);

            // Categorize errors for the AI agent to distinguish:
            // - Game state errors (code -32010): valid CLI but game prevents action
            // - Internal errors: RPC protocol or connection issues
            std::string prefix;
            if (code == -32010)
            {
                prefix = "Blocked: ";
            }
            else
            {
                prefix = "Internal: ";
            }

            throw std::runtime_error(prefix + message);
        }
        if (!response.contains("result"))
        {
            throw std::runtime_error("Internal: Malformed RPC response");
        }
        return response["result"];
    }

private:
    TcpClient _connection;
    int64_t _nextId = 1;
};

} // namespace

class JsonRpcClient::Impl : public JsonRpcClientImpl
{
public:
    using JsonRpcClientImpl::JsonRpcClientImpl;
};

JsonRpcClient::JsonRpcClient(std::string host, uint16_t port)
    : _impl(std::make_unique<JsonRpcClient::Impl>(std::move(host), port))
{
}

JsonRpcClient::~JsonRpcClient() = default;

nlohmann::json JsonRpcClient::Call(const std::string& method, const nlohmann::json& params)
{
    return _impl->Call(method, params);
}

} // namespace rctctl::rpc
