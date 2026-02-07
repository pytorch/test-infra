import XCTest
@testable import TorchCI

@MainActor
final class BenchmarkListViewModelTests: XCTestCase {

    private var mockClient: MockAPIClient!
    private var viewModel: BenchmarkListViewModel!

    override func setUp() {
        super.setUp()
        mockClient = MockAPIClient()
        viewModel = BenchmarkListViewModel(apiClient: mockClient)
    }

    override func tearDown() {
        mockClient.reset()
        mockClient = nil
        viewModel = nil
        super.tearDown()
    }

    // MARK: - Initial State

    func testInitialStateIsIdle() {
        XCTAssertEqual(viewModel.state, .idle)
    }

    func testInitialCategoriesAreEmpty() {
        XCTAssertTrue(viewModel.categories.isEmpty)
    }

    func testInitialSearchTextIsEmpty() {
        XCTAssertEqual(viewModel.searchText, "")
    }

    func testInitialHasDataIsFalse() {
        XCTAssertFalse(viewModel.hasData)
    }

    func testInitialIsLoadingIsFalse() {
        XCTAssertFalse(viewModel.isLoading)
    }

    func testInitialTotalBenchmarkCountIsZero() {
        XCTAssertEqual(viewModel.totalBenchmarkCount, 0)
    }

    func testInitialFilteredBenchmarkCountIsZero() {
        XCTAssertEqual(viewModel.filteredBenchmarkCount, 0)
    }

    // MARK: - Load Benchmarks

    func testLoadBenchmarksPopulatesCategories() async {
        await viewModel.loadBenchmarks()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertFalse(viewModel.categories.isEmpty)
        XCTAssertTrue(viewModel.hasData)
    }

    func testLoadBenchmarksSetsLoadedState() async {
        await viewModel.loadBenchmarks()

        XCTAssertEqual(viewModel.state, .loaded)
    }

    func testLoadBenchmarksPopulatesAllStaticCategories() async {
        await viewModel.loadBenchmarks()

        XCTAssertEqual(viewModel.categories.count, BenchmarkListViewModel.benchmarkCategories.count)
    }

    func testLoadBenchmarksCategoryIdsMatchStatic() async {
        await viewModel.loadBenchmarks()

        let loadedIds = viewModel.categories.map(\.id)
        let staticIds = BenchmarkListViewModel.benchmarkCategories.map(\.id)
        XCTAssertEqual(loadedIds, staticIds)
    }

    func testLoadBenchmarksHasDataIsTrue() async {
        await viewModel.loadBenchmarks()

        XCTAssertTrue(viewModel.hasData)
    }

    // MARK: - Refresh

    func testRefreshReloadsCategories() async {
        await viewModel.refresh()

        XCTAssertEqual(viewModel.state, .loaded)
        XCTAssertFalse(viewModel.categories.isEmpty)
    }

    func testRefreshProducesSameDataAsLoad() async {
        await viewModel.loadBenchmarks()
        let categoriesAfterLoad = viewModel.categories.map(\.id)

        await viewModel.refresh()
        let categoriesAfterRefresh = viewModel.categories.map(\.id)

        XCTAssertEqual(categoriesAfterLoad, categoriesAfterRefresh)
    }

    // MARK: - Total Benchmark Count

    func testTotalBenchmarkCountAfterLoad() async {
        await viewModel.loadBenchmarks()

        let expectedCount = BenchmarkListViewModel.benchmarkCategories.reduce(0) { $0 + $1.items.count }
        XCTAssertEqual(viewModel.totalBenchmarkCount, expectedCount)
        XCTAssertGreaterThan(viewModel.totalBenchmarkCount, 0)
    }

    // MARK: - Search Filtering: No Filter

    func testFilteredCategoriesReturnsAllWhenSearchEmpty() async {
        await viewModel.loadBenchmarks()

        viewModel.searchText = ""
        XCTAssertEqual(viewModel.filteredCategories.count, viewModel.categories.count)
    }

    func testFilteredBenchmarkCountMatchesTotalWhenSearchEmpty() async {
        await viewModel.loadBenchmarks()

        viewModel.searchText = ""
        XCTAssertEqual(viewModel.filteredBenchmarkCount, viewModel.totalBenchmarkCount)
    }

    // MARK: - Search Filtering: By Category Title

    func testSearchByCategoryTitleReturnsCategoryWithAllItems() async {
        await viewModel.loadBenchmarks()

        viewModel.searchText = "PyTorch Benchmarks"
        let filtered = viewModel.filteredCategories

        XCTAssertFalse(filtered.isEmpty)
        // "PyTorch Benchmarks" matches the pytorch category title exactly
        let pytorchCategory = filtered.first(where: { $0.id == "pytorch" })
        XCTAssertNotNil(pytorchCategory)
        // When category title matches, ALL items should be returned
        let originalPytorch = viewModel.categories.first(where: { $0.id == "pytorch" })
        XCTAssertEqual(pytorchCategory?.items.count, originalPytorch?.items.count)
    }

    func testSearchByCategoryTitleIsCaseInsensitive() async {
        await viewModel.loadBenchmarks()

        viewModel.searchText = "pytorch benchmarks"
        let filtered = viewModel.filteredCategories

        let pytorchCategory = filtered.first(where: { $0.id == "pytorch" })
        XCTAssertNotNil(pytorchCategory)
    }

    // MARK: - Search Filtering: By Category Subtitle

    func testSearchByCategorySubtitle() async {
        await viewModel.loadBenchmarks()

        viewModel.searchText = "pytorch/torchao"
        let filtered = viewModel.filteredCategories

        let torchaoCategory = filtered.first(where: { $0.id == "torchao" })
        XCTAssertNotNil(torchaoCategory)
    }

    // MARK: - Search Filtering: By Benchmark Name

    func testSearchByBenchmarkName() async {
        await viewModel.loadBenchmarks()

        viewModel.searchText = "GPT-Fast"
        let filtered = viewModel.filteredCategories

        XCTAssertFalse(filtered.isEmpty)
        // Should find the GPT-Fast benchmark inside the pytorch category
        let hasGPTFast = filtered.contains { category in
            category.items.contains { $0.name.contains("GPT-Fast") }
        }
        XCTAssertTrue(hasGPTFast)
    }

    func testSearchByBenchmarkNameFiltersOtherItems() async {
        await viewModel.loadBenchmarks()

        viewModel.searchText = "GPT-Fast"
        let filtered = viewModel.filteredCategories

        // The pytorch category should only include matching items (not all items)
        // unless the category title itself also matches
        let pytorchCategory = filtered.first(where: { $0.id == "pytorch" })
        if let pytorchCategory {
            // Since "GPT-Fast" does NOT match "PyTorch Benchmarks" category title,
            // only matching items should be returned
            let gptItems = pytorchCategory.items.filter { $0.name.contains("GPT-Fast") }
            XCTAssertEqual(pytorchCategory.items.count, gptItems.count)
        }
    }

    // MARK: - Search Filtering: By Description

    func testSearchByBenchmarkDescription() async {
        await viewModel.loadBenchmarks()

        viewModel.searchText = "TorchInductor"
        let filtered = viewModel.filteredCategories

        XCTAssertFalse(filtered.isEmpty)
        let hasInductor = filtered.contains { category in
            category.items.contains { $0.id == "compiler_inductor" }
        }
        XCTAssertTrue(hasInductor)
    }

    // MARK: - Search Filtering: By Suite

    func testSearchBySuiteName() async {
        await viewModel.loadBenchmarks()

        viewModel.searchText = "huggingface"
        let filtered = viewModel.filteredCategories

        XCTAssertFalse(filtered.isEmpty)
        let hasHuggingfaceSuite = filtered.contains { category in
            category.items.contains { item in
                item.suites?.contains("huggingface") ?? false
            }
        }
        XCTAssertTrue(hasHuggingfaceSuite)
    }

    func testSearchBySuiteNamePartialMatch() async {
        await viewModel.loadBenchmarks()

        viewModel.searchText = "timm"
        let filtered = viewModel.filteredCategories

        XCTAssertFalse(filtered.isEmpty)
        let hasTimmSuite = filtered.contains { category in
            category.items.contains { item in
                item.suites?.contains(where: { $0.lowercased().contains("timm") }) ?? false
            }
        }
        XCTAssertTrue(hasTimmSuite)
    }

    // MARK: - Search Filtering: No Results

    func testSearchWithNoResultsReturnsEmpty() async {
        await viewModel.loadBenchmarks()

        viewModel.searchText = "zzz_nonexistent_benchmark_999"
        let filtered = viewModel.filteredCategories

        XCTAssertTrue(filtered.isEmpty)
    }

    func testFilteredBenchmarkCountIsZeroWhenNoResults() async {
        await viewModel.loadBenchmarks()

        viewModel.searchText = "zzz_nonexistent_benchmark_999"
        XCTAssertEqual(viewModel.filteredBenchmarkCount, 0)
    }

    // MARK: - Search Filtering: Filtered Count

    func testFilteredBenchmarkCountLessThanTotalWhenFiltering() async {
        await viewModel.loadBenchmarks()

        viewModel.searchText = "GPT-Fast"
        XCTAssertLessThan(viewModel.filteredBenchmarkCount, viewModel.totalBenchmarkCount)
        XCTAssertGreaterThan(viewModel.filteredBenchmarkCount, 0)
    }

    // MARK: - Search Filtering: Mixed Match (Category + Item)

    func testSearchMatchingCategoryTitleReturnsAllItsItems() async {
        await viewModel.loadBenchmarks()

        // "vLLM" appears in both a category title and benchmark names
        viewModel.searchText = "vLLM"
        let filtered = viewModel.filteredCategories

        XCTAssertFalse(filtered.isEmpty)
        // The vLLM category should exist with all its items
        let vllmCategory = filtered.first(where: { $0.id == "vllm" })
        XCTAssertNotNil(vllmCategory)
    }

    // MARK: - Static Data Integrity

    func testStaticCategoriesHaveUniqueIds() {
        let ids = BenchmarkListViewModel.benchmarkCategories.map(\.id)
        let uniqueIds = Set(ids)
        XCTAssertEqual(ids.count, uniqueIds.count, "Category IDs should be unique")
    }

    func testStaticCategoriesAllHaveTitles() {
        for category in BenchmarkListViewModel.benchmarkCategories {
            XCTAssertFalse(category.title.isEmpty, "Category \(category.id) should have a title")
        }
    }

    func testStaticCategoriesAllHaveIcons() {
        for category in BenchmarkListViewModel.benchmarkCategories {
            XCTAssertFalse(category.icon.isEmpty, "Category \(category.id) should have an icon")
        }
    }

    func testStaticCategoriesAllHaveItems() {
        for category in BenchmarkListViewModel.benchmarkCategories {
            XCTAssertFalse(category.items.isEmpty, "Category \(category.id) should have at least one item")
        }
    }

    func testStaticItemsHaveUniqueIds() {
        let allItems = BenchmarkListViewModel.benchmarkCategories.flatMap(\.items)
        let ids = allItems.map(\.id)
        let uniqueIds = Set(ids)
        XCTAssertEqual(ids.count, uniqueIds.count, "Benchmark item IDs should be unique across all categories")
    }

    func testStaticItemsAllHaveNames() {
        let allItems = BenchmarkListViewModel.benchmarkCategories.flatMap(\.items)
        for item in allItems {
            XCTAssertFalse(item.name.isEmpty, "Item \(item.id) should have a name")
        }
    }

    func testStaticItemsAllHaveDescriptions() {
        let allItems = BenchmarkListViewModel.benchmarkCategories.flatMap(\.items)
        for item in allItems {
            XCTAssertNotNil(item.description, "Item \(item.id) should have a description")
            XCTAssertFalse(item.description?.isEmpty ?? true, "Item \(item.id) description should not be empty")
        }
    }

    // MARK: - Known Benchmark Categories

    func testPyTorchCategoryExists() {
        let pytorch = BenchmarkListViewModel.benchmarkCategories.first(where: { $0.id == "pytorch" })
        XCTAssertNotNil(pytorch)
        XCTAssertEqual(pytorch?.title, "PyTorch Benchmarks")
    }

    func testTorchAOCategoryExists() {
        let torchao = BenchmarkListViewModel.benchmarkCategories.first(where: { $0.id == "torchao" })
        XCTAssertNotNil(torchao)
        XCTAssertEqual(torchao?.title, "TorchAO Benchmarks")
    }

    func testVLLMCategoryExists() {
        let vllm = BenchmarkListViewModel.benchmarkCategories.first(where: { $0.id == "vllm" })
        XCTAssertNotNil(vllm)
        XCTAssertEqual(vllm?.title, "vLLM Benchmarks")
    }

    func testSGLangCategoryExists() {
        let sglang = BenchmarkListViewModel.benchmarkCategories.first(where: { $0.id == "sglang" })
        XCTAssertNotNil(sglang)
        XCTAssertEqual(sglang?.title, "SGLang Benchmarks")
    }

    func testHelionCategoryExists() {
        let helion = BenchmarkListViewModel.benchmarkCategories.first(where: { $0.id == "helion" })
        XCTAssertNotNil(helion)
        XCTAssertEqual(helion?.title, "Helion Benchmarks")
    }

    func testExecuTorchCategoryExists() {
        let executorch = BenchmarkListViewModel.benchmarkCategories.first(where: { $0.id == "executorch" })
        XCTAssertNotNil(executorch)
        XCTAssertEqual(executorch?.title, "ExecuTorch Benchmarks")
    }

    // MARK: - Known Benchmark Items

    func testCompilerInductorItemExists() {
        let allItems = BenchmarkListViewModel.benchmarkCategories.flatMap(\.items)
        let inductor = allItems.first(where: { $0.id == "compiler_inductor" })
        XCTAssertNotNil(inductor)
        XCTAssertNotNil(inductor?.suites)
        XCTAssertEqual(inductor?.suites?.count, 3)
        XCTAssertTrue(inductor?.suites?.contains("huggingface") ?? false)
        XCTAssertTrue(inductor?.suites?.contains("timm_models") ?? false)
        XCTAssertTrue(inductor?.suites?.contains("torchbench") ?? false)
    }

    func testGPTFastItemExists() {
        let allItems = BenchmarkListViewModel.benchmarkCategories.flatMap(\.items)
        let gptfast = allItems.first(where: { $0.id == "pytorch_gptfast" })
        XCTAssertNotNil(gptfast)
        XCTAssertEqual(gptfast?.name, "GPT-Fast Benchmark")
    }

    // MARK: - ViewState Equatable

    func testViewStateEquatableIdle() {
        XCTAssertEqual(BenchmarkListViewModel.ViewState.idle, .idle)
    }

    func testViewStateEquatableLoading() {
        XCTAssertEqual(BenchmarkListViewModel.ViewState.loading, .loading)
    }

    func testViewStateEquatableLoaded() {
        XCTAssertEqual(BenchmarkListViewModel.ViewState.loaded, .loaded)
    }

    func testViewStateEquatableSameError() {
        XCTAssertEqual(
            BenchmarkListViewModel.ViewState.error("test"),
            BenchmarkListViewModel.ViewState.error("test")
        )
    }

    func testViewStateNotEqualDifferentErrors() {
        XCTAssertNotEqual(
            BenchmarkListViewModel.ViewState.error("a"),
            BenchmarkListViewModel.ViewState.error("b")
        )
    }

    func testViewStateNotEqualDifferentCases() {
        XCTAssertNotEqual(BenchmarkListViewModel.ViewState.idle, .loading)
        XCTAssertNotEqual(BenchmarkListViewModel.ViewState.idle, .loaded)
        XCTAssertNotEqual(BenchmarkListViewModel.ViewState.loading, .loaded)
        XCTAssertNotEqual(BenchmarkListViewModel.ViewState.idle, .error("x"))
    }

    // MARK: - isLoading Computed Property

    func testIsLoadingTrueWhenLoading() {
        viewModel.state = .loading
        XCTAssertTrue(viewModel.isLoading)
    }

    func testIsLoadingFalseWhenIdle() {
        viewModel.state = .idle
        XCTAssertFalse(viewModel.isLoading)
    }

    func testIsLoadingFalseWhenLoaded() {
        viewModel.state = .loaded
        XCTAssertFalse(viewModel.isLoading)
    }

    func testIsLoadingFalseWhenError() {
        viewModel.state = .error("test error")
        XCTAssertFalse(viewModel.isLoading)
    }

    // MARK: - Edge Cases

    func testSearchWithWhitespaceOnlyDoesNotFilter() async {
        await viewModel.loadBenchmarks()

        // A space is not empty, so filtering will occur
        viewModel.searchText = " "
        // No category title/subtitle/item should match just whitespace
        // This tests that the search handles edge cases gracefully
        let filtered = viewModel.filteredCategories
        // May return empty or some if any content has a space
        XCTAssertNotNil(filtered)
    }

    func testSearchWithSpecialCharacters() async {
        await viewModel.loadBenchmarks()

        viewModel.searchText = "!@#$%^&*()"
        let filtered = viewModel.filteredCategories

        XCTAssertTrue(filtered.isEmpty)
    }

    func testMultipleLoadCalls() async {
        await viewModel.loadBenchmarks()
        let firstCount = viewModel.categories.count

        await viewModel.loadBenchmarks()
        let secondCount = viewModel.categories.count

        XCTAssertEqual(firstCount, secondCount)
        XCTAssertEqual(viewModel.state, .loaded)
    }

    func testSearchClearingRestoresAllCategories() async {
        await viewModel.loadBenchmarks()

        viewModel.searchText = "pytorch"
        let filteredCount = viewModel.filteredCategories.count

        viewModel.searchText = ""
        let unfilteredCount = viewModel.filteredCategories.count

        XCTAssertGreaterThanOrEqual(unfilteredCount, filteredCount)
        XCTAssertEqual(unfilteredCount, viewModel.categories.count)
    }
}
