
python ../scripts/generate_binary_build_matrix.py  > ../tests/assets/build_matrix_linux_wheel_cuda.json
python ../scripts/generate_binary_build_matrix.py --with-rocm disable > ../tests/assets/build_matrix_linux_wheel_cuda_norocm.json
python ../scripts/generate_binary_build_matrix.py --with-cpu disable > ../tests/assets/build_matrix_linux_wheel_nocpu.json
python ../scripts/generate_binary_build_matrix.py --package-type conda > ../tests/assets/build_matrix_linux_conda_cuda.json
python ../scripts/generate_binary_build_matrix.py --package-type conda > ../tests/assets/build_matrix_linux_conda_cuda.json
python ../scripts/generate_binary_build_matrix.py --operating-system="macos" > ../tests/assets/build_matrix_macos_wheel.json
python ../scripts/generate_binary_build_matrix.py --operating-system="macos" --package-type conda  > ../tests/assets/build_matrix_macos_conda.json
python ../scripts/generate_binary_build_matrix.py --operating-system="windows" --package-type conda > ../tests/assets/build_matrix_windows_conda_cuda.json
python ../scripts/generate_binary_build_matrix.py --operating-system="windows" > ../tests/assets/build_matrix_windows_wheel_cuda.json
