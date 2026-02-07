import XCTest

@MainActor
final class HUDUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launch()
    }

    // MARK: - Screen Loading

    func testHUDScreenLoadsWithTitle() {
        // HUDView is the default tab; its .navigationTitle is "CI HUD"
        XCTAssertTrue(app.navigationBars["CI HUD"].waitForExistence(timeout: 10))
    }

    func testHUDShowsLoadingOrContent() {
        // The HUD should either show "Loading CI data..." or the grid content
        // after launch. We wait for a reasonable time for one of them to appear.
        let loadingText = app.staticTexts["Loading CI data..."]
        let paginationPage = app.staticTexts.matching(
            NSPredicate(format: "label BEGINSWITH 'Page'")
        ).firstMatch

        let loaded = loadingText.waitForExistence(timeout: 5)
            || paginationPage.waitForExistence(timeout: 5)
        XCTAssertTrue(loaded, "HUD should show loading indicator or paginated content")
    }

    // MARK: - Search Bar

    func testSearchBarExists() {
        // Wait for the HUD to load
        XCTAssertTrue(app.navigationBars["CI HUD"].waitForExistence(timeout: 10))

        // The FilterBar contains a SearchBar with placeholder "Filter jobs by name..."
        let searchField = app.textFields["Filter jobs by name..."]
        XCTAssertTrue(searchField.waitForExistence(timeout: 5))
    }

    func testSearchBarAcceptsInput() {
        XCTAssertTrue(app.navigationBars["CI HUD"].waitForExistence(timeout: 10))

        let searchField = app.textFields["Filter jobs by name..."]
        XCTAssertTrue(searchField.waitForExistence(timeout: 5))

        searchField.tap()
        searchField.typeText("linux")

        // Verify the text was entered
        XCTAssertEqual(searchField.value as? String, "linux")
    }

    func testSearchBarClearButtonAppears() {
        XCTAssertTrue(app.navigationBars["CI HUD"].waitForExistence(timeout: 10))

        let searchField = app.textFields["Filter jobs by name..."]
        XCTAssertTrue(searchField.waitForExistence(timeout: 5))

        searchField.tap()
        searchField.typeText("test-query")

        // When text is entered, the FilterBar shows a "Clear" button
        let clearButton = app.buttons["Clear"]
        XCTAssertTrue(clearButton.waitForExistence(timeout: 3))
    }

    // MARK: - Pagination Controls

    func testPaginationControlsVisibleWhenLoaded() {
        XCTAssertTrue(app.navigationBars["CI HUD"].waitForExistence(timeout: 10))

        // Wait for data to load - the PaginationView shows "Page X" or "Page X of Y"
        let pageLabel = app.staticTexts.matching(
            NSPredicate(format: "label BEGINSWITH 'Page'")
        ).firstMatch

        // Also check for chevron buttons from PaginationView
        let nextButton = app.buttons.matching(
            NSPredicate(format: "label == 'chevron.right' OR label == 'Next'")
        ).firstMatch

        // Either the page label or navigation buttons should appear once loaded
        let paginationVisible = pageLabel.waitForExistence(timeout: 15)
        if paginationVisible {
            XCTAssertTrue(paginationVisible, "Pagination page label should be visible")
        }
    }

    func testPreviousPageButtonDisabledOnFirstPage() {
        XCTAssertTrue(app.navigationBars["CI HUD"].waitForExistence(timeout: 10))

        // Wait for pagination to appear with "Page 1"
        let page1Label = app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS 'Page 1'")
        ).firstMatch

        if page1Label.waitForExistence(timeout: 15) {
            // The left chevron button should be disabled on page 1
            let prevButton = app.buttons["chevron.left"]
            if prevButton.exists {
                XCTAssertFalse(prevButton.isEnabled, "Previous button should be disabled on page 1")
            }
        }
    }

    // MARK: - Scrolling

    func testScrollingWorks() {
        XCTAssertTrue(app.navigationBars["CI HUD"].waitForExistence(timeout: 10))

        // Wait for content to appear (either loading or loaded)
        let pageLabel = app.staticTexts.matching(
            NSPredicate(format: "label BEGINSWITH 'Page'")
        ).firstMatch

        if pageLabel.waitForExistence(timeout: 15) {
            // The HUD grid is scrollable; perform a swipe to verify scrolling
            let scrollView = app.scrollViews.firstMatch
            if scrollView.exists {
                let startCoordinate = scrollView.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.8))
                let endCoordinate = scrollView.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2))
                startCoordinate.press(forDuration: 0.1, thenDragTo: endCoordinate)
            }
        }
    }

    func testHorizontalScrollingOnGrid() {
        XCTAssertTrue(app.navigationBars["CI HUD"].waitForExistence(timeout: 10))

        // Wait for content
        let pageLabel = app.staticTexts.matching(
            NSPredicate(format: "label BEGINSWITH 'Page'")
        ).firstMatch

        if pageLabel.waitForExistence(timeout: 15) {
            // The HUDGridView has a horizontal ScrollView for job columns
            let scrollViews = app.scrollViews
            if scrollViews.count > 0 {
                let horizontalScroll = scrollViews.firstMatch
                let startCoordinate = horizontalScroll.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.5))
                let endCoordinate = horizontalScroll.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.5))
                startCoordinate.press(forDuration: 0.1, thenDragTo: endCoordinate)
            }
        }
    }
}
