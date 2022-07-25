def determine_version_suffix(package_type: str, gpu_arch_version: str, platform: str):
    if platform == "darwin":
        return ""
