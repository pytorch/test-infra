import textwrap

from api.path_filter import PathSpecFilter, DefaultPathFilter

from pathlib import Path

# replicate the logic in path_filter.py file

path_spec = textwrap.dedent("""
        # match only python files
        *.py
        
        # if any dir starts with an underscore, ignore it
        !**/_*/**
        
        # if any dir starts with a dot, ignore it
        !**/.*/**
        
        # file name starts with an underscore, ignore it
        !**/_*
        
        # if any dir is named test, ignore it
        !**/test/**
        
        # if any dir is named benchmarks, ignore it
        !**/benchmarks/**
        
        # file name starts with test_ or ends with _test, ignore it
        !**/test_*.py
        !**/*_test.py
    """)

spec_filter = PathSpecFilter(path_spec)


def test_path_filter():
    assert spec_filter(Path('test.py'))
    assert not spec_filter(Path('test.pyc'))
    assert not spec_filter(Path('test/_test.py'))
    assert not spec_filter(Path('test/file.py'))
    assert spec_filter(Path('dir/test.py'))
    assert not spec_filter(Path('_dir/file.py'))
    assert not spec_filter(Path('dir/_dir/file.py'))
    assert spec_filter(Path('dir/dir/file.py'))
    assert not spec_filter(Path('dir/dir/_file.py'))
    assert spec_filter(Path('dir/dir/.file.py'))
    assert spec_filter(Path('dir/benchmarks.py'))
    assert not spec_filter(Path('dir/benchmarks/test.py'))

    assert not spec_filter(Path('test_.py'))
    assert not spec_filter(Path('_test.py'))


def test_path_filter_on_real_list_of_files():
    default_filter = DefaultPathFilter()
    
    # read 'pytorch_files' file
    # file is in the tests root
    with open('pytorch_files', 'r') as f:
        files = f.read().splitlines()
    
    # compare filter results
    for file in files:
        assert spec_filter(Path(file)) == default_filter(Path(file))
