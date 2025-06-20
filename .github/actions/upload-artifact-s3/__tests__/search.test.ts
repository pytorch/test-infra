import {describe, expect, jest, it, beforeAll} from '@jest/globals'
import * as core from '@actions/core'
import * as path from 'path'
import {findFilesToUpload} from '../src/shared/search'

import {setupPaths, recreateTestData} from './mktestdata'

const paths: Record<string, string> = setupPaths()

describe('Search', () => {
  beforeAll(async () => {
    // mock all output so that there is less noise when running tests
    jest.spyOn(console, 'log').mockImplementation(() => {})
    jest.spyOn(core, 'debug').mockImplementation(() => {})
    jest.spyOn(core, 'info').mockImplementation(() => {})
    jest.spyOn(core, 'warning').mockImplementation(() => {})

    await recreateTestData(paths)
  })

  it('Single file search - Absolute Path', async () => {
    const searchResult = await findFilesToUpload(
      paths['extraFileInFolderCPath']
    )
    expect(searchResult.filesToUpload.length).toEqual(1)
    expect(searchResult.filesToUpload[0]).toEqual(
      paths['extraFileInFolderCPath']
    )
    expect(searchResult.rootDirectory).toEqual(
      path.join(paths['root'], 'folder-a', 'folder-b', 'folder-c')
    )
  })

  it('Single file search - Relative Path', async () => {
    const relativePath = path.join(
      '__tests__',
      '_temp',
      'search',
      'folder-a',
      'folder-b',
      'folder-c',
      'search-item1.txt'
    )

    const searchResult = await findFilesToUpload(relativePath)
    expect(searchResult.filesToUpload.length).toEqual(1)
    expect(searchResult.filesToUpload[0]).toEqual(paths['searchItem1Path'])
    expect(searchResult.rootDirectory).toEqual(
      path.join(paths['root'], 'folder-a', 'folder-b', 'folder-c')
    )
  })

  it('Single file using wildcard', async () => {
    const expectedRoot = path.join(paths['root'], 'folder-h')
    const searchPath = path.join(paths['root'], 'folder-h', '**/*lonely*')
    const searchResult = await findFilesToUpload(searchPath)
    expect(searchResult.filesToUpload.length).toEqual(1)
    expect(searchResult.filesToUpload[0]).toEqual(paths['lonelyFilePath'])
    expect(searchResult.rootDirectory).toEqual(expectedRoot)
  })

  it('Single file using directory', async () => {
    const searchPath = path.join(paths['root'], 'folder-h', 'folder-j')
    const searchResult = await findFilesToUpload(searchPath)
    expect(searchResult.filesToUpload.length).toEqual(1)
    expect(searchResult.filesToUpload[0]).toEqual(paths['lonelyFilePath'])
    expect(searchResult.rootDirectory).toEqual(searchPath)
  })

  it('Directory search - Absolute Path', async () => {
    const searchPath = path.join(paths['root'], 'folder-h')
    const searchResult = await findFilesToUpload(searchPath)
    expect(searchResult.filesToUpload.length).toEqual(4)

    expect(
      searchResult.filesToUpload.includes(paths['amazingFileInFolderHPath'])
    ).toEqual(true)
    expect(
      searchResult.filesToUpload.includes(paths['extraSearchItem4Path'])
    ).toEqual(true)
    expect(
      searchResult.filesToUpload.includes(paths['extraSearchItem5Path'])
    ).toEqual(true)
    expect(
      searchResult.filesToUpload.includes(paths['lonelyFilePath'])
    ).toEqual(true)

    expect(searchResult.rootDirectory).toEqual(searchPath)
  })

  it('Directory search - Relative Path', async () => {
    const searchPath = path.join('__tests__', '_temp', 'search', 'folder-h')
    const expectedRootDirectory = path.join(paths['root'], 'folder-h')
    const searchResult = await findFilesToUpload(searchPath)
    expect(searchResult.filesToUpload.length).toEqual(4)

    expect(
      searchResult.filesToUpload.includes(paths['amazingFileInFolderHPath'])
    ).toEqual(true)
    expect(
      searchResult.filesToUpload.includes(paths['extraSearchItem4Path'])
    ).toEqual(true)
    expect(
      searchResult.filesToUpload.includes(paths['extraSearchItem5Path'])
    ).toEqual(true)
    expect(
      searchResult.filesToUpload.includes(paths['lonelyFilePath'])
    ).toEqual(true)

    expect(searchResult.rootDirectory).toEqual(expectedRootDirectory)
  })

  it('Wildcard search - Absolute Path', async () => {
    const searchPath = path.join(paths['root'], '**/*[Ss]earch*')
    const searchResult = await findFilesToUpload(searchPath)
    expect(searchResult.filesToUpload.length).toEqual(10)

    expect(
      searchResult.filesToUpload.includes(paths['searchItem1Path'])
    ).toEqual(true)
    expect(
      searchResult.filesToUpload.includes(paths['searchItem2Path'])
    ).toEqual(true)
    expect(
      searchResult.filesToUpload.includes(paths['searchItem3Path'])
    ).toEqual(true)
    expect(
      searchResult.filesToUpload.includes(paths['searchItem4Path'])
    ).toEqual(true)
    expect(
      searchResult.filesToUpload.includes(paths['searchItem5Path'])
    ).toEqual(true)
    expect(
      searchResult.filesToUpload.includes(paths['extraSearchItem1Path'])
    ).toEqual(true)
    expect(
      searchResult.filesToUpload.includes(paths['extraSearchItem2Path'])
    ).toEqual(true)
    expect(
      searchResult.filesToUpload.includes(paths['extraSearchItem3Path'])
    ).toEqual(true)
    expect(
      searchResult.filesToUpload.includes(paths['extraSearchItem4Path'])
    ).toEqual(true)
    expect(
      searchResult.filesToUpload.includes(paths['extraSearchItem5Path'])
    ).toEqual(true)

    expect(searchResult.rootDirectory).toEqual(paths['root'])
  })

  it('Wildcard search - Relative Path', async () => {
    const searchPath = path.join(
      '__tests__',
      '_temp',
      'search',
      '**/*[Ss]earch*'
    )
    const searchResult = await findFilesToUpload(searchPath)
    expect(searchResult.filesToUpload.length).toEqual(10)

    expect(
      searchResult.filesToUpload.includes(paths['searchItem1Path'])
    ).toEqual(true)
    expect(
      searchResult.filesToUpload.includes(paths['searchItem2Path'])
    ).toEqual(true)
    expect(
      searchResult.filesToUpload.includes(paths['searchItem3Path'])
    ).toEqual(true)
    expect(
      searchResult.filesToUpload.includes(paths['searchItem4Path'])
    ).toEqual(true)
    expect(
      searchResult.filesToUpload.includes(paths['searchItem5Path'])
    ).toEqual(true)
    expect(
      searchResult.filesToUpload.includes(paths['extraSearchItem1Path'])
    ).toEqual(true)
    expect(
      searchResult.filesToUpload.includes(paths['extraSearchItem2Path'])
    ).toEqual(true)
    expect(
      searchResult.filesToUpload.includes(paths['extraSearchItem3Path'])
    ).toEqual(true)
    expect(
      searchResult.filesToUpload.includes(paths['extraSearchItem4Path'])
    ).toEqual(true)
    expect(
      searchResult.filesToUpload.includes(paths['extraSearchItem5Path'])
    ).toEqual(true)

    expect(searchResult.rootDirectory).toEqual(paths['root'])
  })

  it('Multi path search - root directory', async () => {
    const searchPath1 = path.join(paths['root'], 'folder-a')
    const searchPath2 = path.join(paths['root'], 'folder-d')

    const searchPaths = searchPath1 + '\n' + searchPath2
    const searchResult = await findFilesToUpload(searchPaths)

    expect(searchResult.rootDirectory).toEqual(paths['root'])
    expect(searchResult.filesToUpload.length).toEqual(7)
    expect(
      searchResult.filesToUpload.includes(paths['searchItem1Path'])
    ).toEqual(true)
    expect(
      searchResult.filesToUpload.includes(paths['searchItem2Path'])
    ).toEqual(true)
    expect(
      searchResult.filesToUpload.includes(paths['searchItem3Path'])
    ).toEqual(true)
    expect(
      searchResult.filesToUpload.includes(paths['searchItem4Path'])
    ).toEqual(true)
    expect(
      searchResult.filesToUpload.includes(paths['extraSearchItem1Path'])
    ).toEqual(true)
    expect(
      searchResult.filesToUpload.includes(paths['extraSearchItem2Path'])
    ).toEqual(true)
    expect(
      searchResult.filesToUpload.includes(paths['extraFileInFolderCPath'])
    ).toEqual(true)
  })

  it('Multi path search - with exclude character', async () => {
    const searchPath1 = path.join(paths['root'], 'folder-a')
    const searchPath2 = path.join(paths['root'], 'folder-d')
    const searchPath3 = path.join(
      paths['root'],
      'folder-a',
      'folder-b',
      '**/extra*.txt'
    )

    // negating the third search path
    const searchPaths = searchPath1 + '\n' + searchPath2 + '\n!' + searchPath3
    const searchResult = await findFilesToUpload(searchPaths)

    expect(searchResult.rootDirectory).toEqual(paths['root'])
    expect(searchResult.filesToUpload.length).toEqual(5)
    expect(
      searchResult.filesToUpload.includes(paths['searchItem1Path'])
    ).toEqual(true)
    expect(
      searchResult.filesToUpload.includes(paths['searchItem2Path'])
    ).toEqual(true)
    expect(
      searchResult.filesToUpload.includes(paths['searchItem3Path'])
    ).toEqual(true)
    expect(
      searchResult.filesToUpload.includes(paths['searchItem4Path'])
    ).toEqual(true)
    expect(
      searchResult.filesToUpload.includes(paths['extraSearchItem2Path'])
    ).toEqual(true)
  })

  it('Multi path search - non root directory', async () => {
    const searchPath1 = path.join(paths['root'], 'folder-h', 'folder-i')
    const searchPath2 = path.join(
      paths['root'],
      'folder-h',
      'folder-j',
      'folder-k'
    )
    const searchPath3 = paths['amazingFileInFolderHPath']

    const searchPaths = [searchPath1, searchPath2, searchPath3].join('\n')
    const searchResult = await findFilesToUpload(searchPaths)

    expect(searchResult.rootDirectory).toEqual(
      path.join(paths['root'], 'folder-h')
    )
    expect(searchResult.filesToUpload.length).toEqual(4)
    expect(
      searchResult.filesToUpload.includes(paths['amazingFileInFolderHPath'])
    ).toEqual(true)
    expect(
      searchResult.filesToUpload.includes(paths['extraSearchItem4Path'])
    ).toEqual(true)
    expect(
      searchResult.filesToUpload.includes(paths['extraSearchItem5Path'])
    ).toEqual(true)
    expect(
      searchResult.filesToUpload.includes(paths['lonelyFilePath'])
    ).toEqual(true)
  })

  it('Hidden files ignored by default', async () => {
    const searchPath = path.join(paths['root'], '**/*')
    const searchResult = await findFilesToUpload(searchPath)

    expect(searchResult.filesToUpload).not.toContain(paths['hiddenFile'])
    expect(searchResult.filesToUpload).not.toContain(
      paths['fileInHiddenFolderPath']
    )
    expect(searchResult.filesToUpload).not.toContain(
      paths['fileInHiddenFolderInFolderA']
    )
  })

  it('Hidden files included', async () => {
    const searchPath = path.join(paths['root'], '**/*')
    const searchResult = await findFilesToUpload(searchPath, true)

    expect(searchResult.filesToUpload).toContain(paths['hiddenFile'])
    expect(searchResult.filesToUpload).toContain(
      paths['fileInHiddenFolderPath']
    )
    expect(searchResult.filesToUpload).toContain(
      paths['fileInHiddenFolderInFolderA']
    )
  })
})
