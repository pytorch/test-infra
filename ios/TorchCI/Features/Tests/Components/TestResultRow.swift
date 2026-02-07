import SwiftUI

struct TestResultRow: View {
    let test: TestResult

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                // Test name - primary info
                Text(test.name)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(2)

                // Suite/classname
                if !test.classname.isEmpty {
                    HStack(spacing: 4) {
                        Image(systemName: "folder")
                            .font(.caption2)
                        Text(test.classname)
                            .font(.caption)
                    }
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                }

                // File and last run metadata row
                HStack(spacing: 12) {
                    if !test.file.isEmpty {
                        HStack(spacing: 4) {
                            Image(systemName: "doc.text")
                                .font(.caption2)
                            Text(shortFileName(test.file))
                                .font(.caption)
                                .lineLimit(1)
                        }
                        .foregroundStyle(.secondary)
                    }

                    if !test.lastRun.isEmpty {
                        HStack(spacing: 4) {
                            Image(systemName: "clock")
                                .font(.caption2)
                            Text(relativeTime)
                                .font(.caption)
                        }
                        .foregroundStyle(.tertiary)
                    }
                }
            }

            Spacer()

            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 4)
        .contentShape(Rectangle())
    }

    // MARK: - Helpers

    /// Shorten file path to just the filename for compact display
    private func shortFileName(_ path: String) -> String {
        if let lastSlash = path.lastIndex(of: "/") {
            return String(path[path.index(after: lastSlash)...])
        }
        return path
    }

    /// Format lastRun as a relative time string
    private var relativeTime: String {
        TestSearchViewModel.formatRelativeTime(test.lastRun) ?? test.lastRun
    }
}

#Preview {
    List {
        TestResultRow(test: TestResult(
            name: "test_conv2d_backward_gpu",
            classname: "TestConvolutionNNDeviceTypeCUDA",
            file: "test/test_nn.py",
            invokingFile: "test_nn",
            lastRun: "2025-01-15T10:30:00Z"
        ))
        TestResultRow(test: TestResult(
            name: "test_autograd_complex_double",
            classname: "TestAutogradDeviceTypeCPU",
            file: "test/test_autograd.py",
            invokingFile: "test_autograd",
            lastRun: "2025-01-14T08:00:00Z"
        ))
        TestResultRow(test: TestResult(
            name: "test_distributed_nccl_allreduce_with_very_long_test_name_that_wraps",
            classname: "TestDistributedNCCL",
            file: "test/distributed/test_nccl.py",
            invokingFile: "test_nccl",
            lastRun: ""
        ))
    }
}
