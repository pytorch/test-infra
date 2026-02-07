// swift-tools-version: 6.0
// The swift-tools-version declares the minimum version of Swift required to build this package.

import PackageDescription

let package = Package(
    name: "TorchCI",
    platforms: [
        .iOS(.v17)
    ],
    products: [
        .library(
            name: "TorchCI",
            targets: ["TorchCI"]
        ),
    ],
    targets: [
        .target(
            name: "TorchCI",
            path: "TorchCI"
        ),
        .testTarget(
            name: "TorchCITests",
            dependencies: ["TorchCI"],
            path: "TorchCITests"
        ),
    ]
)
