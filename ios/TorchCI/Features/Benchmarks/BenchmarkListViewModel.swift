import Foundation
import SwiftUI

@MainActor
final class BenchmarkListViewModel: ObservableObject {
    // MARK: - State

    enum ViewState: Equatable {
        case idle
        case loading
        case loaded
        case error(String)

        static func == (lhs: ViewState, rhs: ViewState) -> Bool {
            switch (lhs, rhs) {
            case (.idle, .idle), (.loading, .loading), (.loaded, .loaded):
                return true
            case let (.error(a), .error(b)):
                return a == b
            default:
                return false
            }
        }
    }

    @Published var state: ViewState = .idle
    @Published var categories: [BenchmarkCategory] = []
    @Published var searchText: String = ""

    // MARK: - Dependencies

    private let apiClient: APIClientProtocol

    // MARK: - Benchmark Categories (mirrors web BENCHMARK_CATEGORIES)

    static let benchmarkCategories: [BenchmarkCategory] = [
        BenchmarkCategory(
            id: "pytorch",
            title: "PyTorch Benchmarks",
            subtitle: "Benchmarks related to repo pytorch/pytorch",
            icon: "cpu",
            color: .orange,
            items: [
                BenchmarkItem(
                    id: "compiler_inductor",
                    name: "Compiler Inductor Benchmark",
                    description: "TorchInductor compiler performance benchmarks",
                    info: "Powered by PyTorch dynamo benchmarking suite",
                    suites: ["huggingface", "timm_models", "torchbench"]
                ),
                BenchmarkItem(
                    id: "pytorch_x_vllm_benchmark",
                    name: "PyTorch x vLLM Benchmark",
                    description: "PyTorch x vLLM nightly benchmark using vLLM pinned commit",
                    info: "Powered by vllm-benchmark workflow"
                ),
                BenchmarkItem(
                    id: "pytorch_gptfast",
                    name: "GPT-Fast Benchmark",
                    description: "PyTorch gpt-fast LLM benchmark",
                    info: "Powered by PyTorch gpt-fast benchmarks"
                ),
                BenchmarkItem(
                    id: "pytorch_operator_microbenchmark",
                    name: "Operator Microbenchmark",
                    description: "PyTorch operator-level microbenchmarks",
                    info: "Powered by operator_benchmark suite"
                ),
            ]
        ),
        BenchmarkCategory(
            id: "torchao",
            title: "TorchAO Benchmarks",
            subtitle: "Benchmarks related to repo pytorch/torchao",
            icon: "bolt.circle.fill",
            color: .blue,
            items: [
                BenchmarkItem(
                    id: "torchao_micro_api_benchmark",
                    name: "TorchAO API Microbenchmark",
                    description: "TorchAO micro-benchmark API performance tracking",
                    info: "Powered by TorchAO benchmarking API"
                ),
            ]
        ),
        BenchmarkCategory(
            id: "vllm",
            title: "vLLM Benchmarks",
            subtitle: "Benchmarks related to repo vllm-project/vllm",
            icon: "brain",
            color: .purple,
            items: [
                BenchmarkItem(
                    id: "vllm_benchmark",
                    name: "vLLM V1 Benchmark",
                    description: "vLLM serving framework benchmark",
                    info: "Powered by pytorch-integration-testing benchmarks"
                ),
            ]
        ),
        BenchmarkCategory(
            id: "sglang",
            title: "SGLang Benchmarks",
            subtitle: "Benchmarks related to repo sgl-project/sglang",
            icon: "cloud.fill",
            color: .green,
            items: [
                BenchmarkItem(
                    id: "sglang_benchmark",
                    name: "SGLang Benchmark",
                    description: "SGLang serving framework benchmark",
                    info: "Powered by sglang-benchmarks suite"
                ),
            ]
        ),
        BenchmarkCategory(
            id: "helion",
            title: "Helion Benchmarks",
            subtitle: "Benchmarks related to repo pytorch/helion",
            icon: "flame.fill",
            color: .red,
            items: [
                BenchmarkItem(
                    id: "pytorch_helion",
                    name: "Helion Benchmark",
                    description: "PyTorch Helion GPU kernel benchmarks",
                    info: "Powered by Helion kernel benchmarks"
                ),
            ]
        ),
        BenchmarkCategory(
            id: "executorch",
            title: "ExecuTorch Benchmarks",
            subtitle: "Benchmarks related to repo pytorch/executorch",
            icon: "arrow.triangle.2.circlepath.circle.fill",
            color: .cyan,
            items: [
                BenchmarkItem(
                    id: "executorch_benchmark",
                    name: "ExecuTorch Benchmark",
                    description: "ExecuTorch on-device inference benchmarks",
                    info: "Powered by ExecuTorch CI workflows"
                ),
            ]
        ),
    ]

    // MARK: - Computed

    var filteredCategories: [BenchmarkCategory] {
        guard !searchText.isEmpty else { return categories }
        let lowered = searchText.lowercased()

        return categories.compactMap { category in
            let categoryMatches = category.title.lowercased().contains(lowered)
                || (category.subtitle?.lowercased().contains(lowered) ?? false)

            let filteredItems = category.items.filter { item in
                item.name.lowercased().contains(lowered)
                    || (item.description?.lowercased().contains(lowered) ?? false)
                    || (item.suites?.contains(where: { $0.lowercased().contains(lowered) }) ?? false)
            }

            if categoryMatches {
                return category
            } else if !filteredItems.isEmpty {
                return BenchmarkCategory(
                    id: category.id,
                    title: category.title,
                    subtitle: category.subtitle,
                    icon: category.icon,
                    color: category.color,
                    items: filteredItems
                )
            }
            return nil
        }
    }

    var isLoading: Bool {
        state == .loading
    }

    var hasData: Bool {
        !categories.isEmpty
    }

    var totalBenchmarkCount: Int {
        categories.reduce(0) { $0 + $1.items.count }
    }

    var filteredBenchmarkCount: Int {
        filteredCategories.reduce(0) { $0 + $1.items.count }
    }

    // MARK: - Init

    init(apiClient: APIClientProtocol = APIClient.shared) {
        self.apiClient = apiClient
    }

    // MARK: - Actions

    func loadBenchmarks() async {
        if state != .loaded {
            state = .loading
        }
        categories = Self.benchmarkCategories
        state = .loaded
    }

    func refresh() async {
        await loadBenchmarks()
    }
}

// MARK: - Category & Item Models

struct BenchmarkCategory: Identifiable {
    let id: String
    let title: String
    let subtitle: String?
    let icon: String
    let color: Color
    let items: [BenchmarkItem]
}

struct BenchmarkItem: Identifiable {
    let id: String
    let name: String
    let description: String?
    let info: String?
    let suites: [String]?

    init(id: String, name: String, description: String?, info: String? = nil, suites: [String]? = nil) {
        self.id = id
        self.name = name
        self.description = description
        self.info = info
        self.suites = suites
    }
}
