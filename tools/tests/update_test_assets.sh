
python ../scripts/generate_binary_build_matrix.py --build-python-only disable --with-xpu disable > ../tests/assets/build_matrix_linux_wheel_cuda.json
python ../scripts/generate_binary_build_matrix.py --build-python-only disable --with-rocm disable --with-xpu disable > ../tests/assets/build_matrix_linux_wheel_cuda_norocm.json
python ../scripts/generate_binary_build_matrix.py --build-python-only disable --with-cpu disable --with-xpu disable > ../tests/assets/build_matrix_linux_wheel_nocpu.json
python ../scripts/generate_binary_build_matrix.py --build-python-only disable --with-cpu disable --with-rocm disable  --with-xpu enable > ../tests/assets/build_matrix_linux_wheel_xpu.json
python ../scripts/generate_binary_build_matrix.py --build-python-only disable --package-type conda > ../tests/assets/build_matrix_linux_conda_cuda.json
python ../scripts/generate_binary_build_matrix.py --build-python-only disable --package-type conda > ../tests/assets/build_matrix_linux_conda_cuda.json
python ../scripts/generate_binary_build_matrix.py --build-python-only disable --operating-system="macos" --with-cuda disable --with-rocm disable > ../tests/assets/build_matrix_macos_wheel.json
python ../scripts/generate_binary_build_matrix.py --build-python-only disable --operating-system="macos" --package-type conda  > ../tests/assets/build_matrix_macos_conda.json
python ../scripts/generate_binary_build_matrix.py --build-python-only disable --operating-system="windows" --package-type conda > ../tests/assets/build_matrix_windows_conda_cuda.json
python ../scripts/generate_binary_build_matrix.py --build-python-only disable --operating-system="windows" > ../tests/assets/build_matrix_windows_wheel_cuda.json
