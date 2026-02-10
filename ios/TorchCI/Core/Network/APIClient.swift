import Foundation

protocol APIClientProtocol: Sendable {
    func fetch<T: Decodable>(_ endpoint: APIEndpoint) async throws -> T
    func fetchRaw(_ endpoint: APIEndpoint) async throws -> Data
    func stream(_ endpoint: APIEndpoint) -> AsyncThrowingStream<Data, Error>
}

final class APIClient: APIClientProtocol, @unchecked Sendable {
    static let shared = APIClient()

    private let session: URLSession
    private let decoder: JSONDecoder
    private let baseURL: URL

    init(
        session: URLSession = .shared,
        baseURL: URL = URL(string: "https://ouwu4mgduf.execute-api.us-east-1.amazonaws.com")!
    ) {
        self.session = session
        self.baseURL = baseURL

        self.decoder = JSONDecoder()
        let isoFormatter = ISO8601DateFormatter()
        let msFormatter = DateFormatter()
        msFormatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSSZ"
        let basicFormatter = DateFormatter()
        basicFormatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ssZ"
        self.decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let dateString = try container.decode(String.self)

            if let date = isoFormatter.date(from: dateString) {
                return date
            }
            if let date = msFormatter.date(from: dateString) {
                return date
            }
            if let date = basicFormatter.date(from: dateString) {
                return date
            }
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Cannot decode date: \(dateString)"
            )
        }
    }

    private static let maxRetries = 3
    private static let baseDelay: UInt64 = 1_000_000_000 // 1 second in nanoseconds

    func fetch<T: Decodable>(_ endpoint: APIEndpoint) async throws -> T {
        let request = try buildRequest(for: endpoint)
        let data = try await performWithRetry(request: request)
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            print("[API] Decode error for \(endpoint.path): \(error)")
            let preview = String(data: data.prefix(500), encoding: .utf8) ?? "<binary>"
            print("[API] Response preview: \(preview)")
            throw APIError.decodingError(error)
        }
    }

    func fetchRaw(_ endpoint: APIEndpoint) async throws -> Data {
        let request = try buildRequest(for: endpoint)
        return try await performWithRetry(request: request)
    }

    private func performWithRetry(request: URLRequest) async throws -> Data {
        var lastError: Error = APIError.invalidResponse
        for attempt in 0..<Self.maxRetries {
            do {
                print("[API] \(request.httpMethod ?? "GET") \(request.url?.absoluteString ?? "?") (attempt \(attempt + 1))")
                let (data, response) = try await session.data(for: request)
                let httpResponse = response as? HTTPURLResponse
                let statusCode = httpResponse?.statusCode ?? -1
                print("[API] \(statusCode) \(request.url?.path ?? "") (\(data.count) bytes)")

                if statusCode == 429 {
                    let retryAfter = httpResponse?.value(forHTTPHeaderField: "Retry-After")
                        .flatMap { UInt64($0) } ?? (1 << attempt)
                    print("[API] Rate limited, retrying after \(retryAfter)s...")
                    try await Task.sleep(nanoseconds: retryAfter * 1_000_000_000)
                    lastError = APIError.rateLimited
                    continue
                }

                if statusCode < 200 || statusCode >= 300 {
                    let body = String(data: data.prefix(500), encoding: .utf8) ?? "<binary>"
                    print("[API] Error body: \(body)")
                }
                try validateResponse(response)
                return data
            } catch let error as APIError where error.isRetryable && attempt < Self.maxRetries - 1 {
                let delay = Self.baseDelay * (1 << attempt)
                print("[API] Retryable error: \(error.localizedDescription), retrying in \(1 << attempt)s...")
                try await Task.sleep(nanoseconds: delay)
                lastError = error
            } catch {
                print("[API] Error: \(error)")
                throw error
            }
        }
        print("[API] All retries exhausted for \(request.url?.absoluteString ?? "?")")
        throw lastError
    }

    func stream(_ endpoint: APIEndpoint) -> AsyncThrowingStream<Data, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let request = try buildRequest(for: endpoint)
                    let (bytes, response) = try await session.bytes(for: request)
                    try validateResponse(response)

                    var buffer = Data()
                    for try await byte in bytes {
                        guard !Task.isCancelled else { break }
                        buffer.append(byte)
                        if byte == UInt8(ascii: "\n") {
                            continuation.yield(buffer)
                            buffer = Data()
                        }
                    }
                    if !buffer.isEmpty {
                        continuation.yield(buffer)
                    }
                    continuation.finish()
                } catch {
                    if !Task.isCancelled {
                        continuation.finish(throwing: error)
                    } else {
                        continuation.finish()
                    }
                }
            }
            continuation.onTermination = { @Sendable _ in
                task.cancel()
            }
        }
    }

    private func buildRequest(for endpoint: APIEndpoint) throws -> URLRequest {
        // Use string concatenation instead of appendingPathComponent to
        // preserve percent-encoding in the path (e.g. %2F in nested query names).
        let baseString = baseURL.absoluteString.hasSuffix("/")
            ? String(baseURL.absoluteString.dropLast())
            : baseURL.absoluteString
        let pathString = endpoint.path.hasPrefix("/") ? endpoint.path : "/\(endpoint.path)"
        guard var components = URLComponents(string: baseString + pathString) else {
            throw APIError.invalidURL
        }

        if let queryItems = endpoint.queryItems, !queryItems.isEmpty {
            components.queryItems = queryItems
        }

        guard let url = components.url else {
            throw APIError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = endpoint.method.rawValue
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        if let body = endpoint.body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }

        // Bot token is injected by the Lambda proxy; no need to send from the app.
        // GitHub auth is forwarded through for user-specific endpoints.
        if let token = KeychainHelper.shared.read(key: "github_access_token") {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        request.timeoutInterval = endpoint.timeout

        return request
    }

    private func validateResponse(_ response: URLResponse) throws {
        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }

        switch httpResponse.statusCode {
        case 200...299:
            return
        case 401:
            throw APIError.unauthorized
        case 403:
            throw APIError.forbidden
        case 404:
            throw APIError.notFound
        case 429:
            throw APIError.rateLimited
        case 500...599:
            throw APIError.serverError(httpResponse.statusCode)
        default:
            throw APIError.httpError(httpResponse.statusCode)
        }
    }
}
