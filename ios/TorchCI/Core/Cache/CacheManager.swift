import Foundation

actor CacheManager {
    static let shared = CacheManager()

    private var memoryCache: [String: CacheEntry] = [:]
    private let fileManager = FileManager.default
    private let cacheDirectory: URL

    private struct CacheEntry {
        let data: Data
        let timestamp: Date
        let ttl: TimeInterval
        var isExpired: Bool { Date().timeIntervalSince(timestamp) > ttl }
    }

    private init() {
        let paths = fileManager.urls(for: .cachesDirectory, in: .userDomainMask)
        cacheDirectory = paths[0].appendingPathComponent("TorchCI", isDirectory: true)
        try? fileManager.createDirectory(at: cacheDirectory, withIntermediateDirectories: true)
    }

    func get<T: Codable>(key: String, type: T.Type) -> T? {
        // Check memory cache
        if let entry = memoryCache[key], !entry.isExpired {
            return try? JSONDecoder().decode(T.self, from: entry.data)
        }

        // Check disk cache
        let fileURL = cacheDirectory.appendingPathComponent(key.sha256Hash)
        guard let data = try? Data(contentsOf: fileURL) else { return nil }

        if let wrapper = try? JSONDecoder().decode(CacheWrapper<T>.self, from: data) {
            if Date().timeIntervalSince(wrapper.timestamp) < wrapper.ttl {
                return wrapper.value
            } else {
                try? fileManager.removeItem(at: fileURL)
            }
        }

        return nil
    }

    func set<T: Codable>(key: String, value: T, ttl: TimeInterval = 300) {
        // Memory cache
        if let data = try? JSONEncoder().encode(value) {
            memoryCache[key] = CacheEntry(data: data, timestamp: Date(), ttl: ttl)

            // Disk cache
            let wrapper = CacheWrapper(value: value, timestamp: Date(), ttl: ttl)
            if let wrapperData = try? JSONEncoder().encode(wrapper) {
                let fileURL = cacheDirectory.appendingPathComponent(key.sha256Hash)
                try? wrapperData.write(to: fileURL)
            }
        }
    }

    func invalidate(key: String) {
        memoryCache.removeValue(forKey: key)
        let fileURL = cacheDirectory.appendingPathComponent(key.sha256Hash)
        try? fileManager.removeItem(at: fileURL)
    }

    func clearAll() {
        memoryCache.removeAll()
        try? fileManager.removeItem(at: cacheDirectory)
        try? fileManager.createDirectory(at: cacheDirectory, withIntermediateDirectories: true)
    }
}

private struct CacheWrapper<T: Codable>: Codable {
    let value: T
    let timestamp: Date
    let ttl: TimeInterval
}

extension String {
    var sha256Hash: String {
        let data = Data(self.utf8)
        var hash = [UInt8](repeating: 0, count: 32)
        data.withUnsafeBytes { buffer in
            guard let baseAddress = buffer.baseAddress else { return }
            var hasher = SimpleHasher()
            hasher.combine(bytes: baseAddress, count: data.count)
            hash = hasher.finalize()
        }
        return hash.map { String(format: "%02x", $0) }.joined()
    }
}

private struct SimpleHasher {
    private var data = Data()

    mutating func combine(bytes: UnsafeRawPointer, count: Int) {
        data.append(Data(bytes: bytes, count: count))
    }

    func finalize() -> [UInt8] {
        // Simple hash for cache keys - not cryptographic
        var result = [UInt8](repeating: 0, count: 32)
        for (i, byte) in data.enumerated() {
            result[i % 32] ^= byte
            result[(i + 1) % 32] = result[(i + 1) % 32] &+ byte
        }
        return result
    }
}
