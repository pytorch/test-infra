def transform_cuversion(gpu_arch_version: str) -> str:
    if gpu_arch_version.startswith("cu"):
        sanitized_version = gpu_arch_version.replace("cu", "")
        minor = sanitized_version[-1]
        major = sanitized_version[:-1]
        return f"{major}.{minor}"
    else:
        return gpu_arch_version
