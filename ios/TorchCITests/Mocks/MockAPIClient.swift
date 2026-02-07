import Foundation
@testable import TorchCI

final class MockAPIClient: APIClientProtocol {

    // MARK: - Configurable responses

    /// Maps endpoint paths to raw `Data` that will be decoded by `fetch`.
    var responses: [String: Data] = [:]

    /// Maps endpoint paths to errors that should be thrown.
    var errors: [String: Error] = [:]

    /// When non-nil, every call is delayed by this many nanoseconds.
    var artificialDelayNanoseconds: UInt64?

    /// Chunks yielded one-by-one when `stream` is called.
    var streamChunks: [Data] = []

    /// Error to throw during streaming (after yielding `streamChunks`).
    var streamError: Error?

    // MARK: - Call recording

    struct RecordedCall: Equatable {
        let path: String
        let method: String
        let queryItems: [URLQueryItem]?
    }

    private(set) var recordedCalls: [RecordedCall] = []

    var callCount: Int { recordedCalls.count }

    func callPaths() -> [String] {
        recordedCalls.map(\.path)
    }

    // MARK: - Helpers

    /// Convenience – register a JSON string for a given path.
    func setResponse(_ json: String, for path: String) {
        responses[path] = json.data(using: .utf8)!
    }

    /// Convenience – register an `Encodable` value for a given path.
    func setResponse<T: Encodable>(_ value: T, for path: String) throws {
        responses[path] = try JSONEncoder().encode(value)
    }

    func setError(_ error: Error, for path: String) {
        errors[path] = error
    }

    func reset() {
        responses.removeAll()
        errors.removeAll()
        recordedCalls.removeAll()
        streamChunks.removeAll()
        streamError = nil
        artificialDelayNanoseconds = nil
    }

    // MARK: - APIClientProtocol

    func fetch<T: Decodable>(_ endpoint: APIEndpoint) async throws -> T {
        record(endpoint)
        try await applyDelay()

        if let error = errors[endpoint.path] {
            throw error
        }

        guard let data = responses[endpoint.path] else {
            throw APIError.notFound
        }

        let decoder = JSONDecoder()
        return try decoder.decode(T.self, from: data)
    }

    func fetchRaw(_ endpoint: APIEndpoint) async throws -> Data {
        record(endpoint)
        try await applyDelay()

        if let error = errors[endpoint.path] {
            throw error
        }

        guard let data = responses[endpoint.path] else {
            throw APIError.notFound
        }

        return data
    }

    func stream(_ endpoint: APIEndpoint) -> AsyncThrowingStream<Data, Error> {
        record(endpoint)
        let chunks = streamChunks
        let error = streamError

        return AsyncThrowingStream { continuation in
            Task {
                for chunk in chunks {
                    continuation.yield(chunk)
                }
                if let error {
                    continuation.finish(throwing: error)
                } else {
                    continuation.finish()
                }
            }
        }
    }

    // MARK: - Private

    private func record(_ endpoint: APIEndpoint) {
        let call = RecordedCall(
            path: endpoint.path,
            method: endpoint.method.rawValue,
            queryItems: endpoint.queryItems
        )
        recordedCalls.append(call)
    }

    private func applyDelay() async throws {
        if let ns = artificialDelayNanoseconds {
            try await Task.sleep(nanoseconds: ns)
        }
    }
}
