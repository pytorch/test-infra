import * as path from 'path'
import * as io from '@actions/io'
import {promises as fs} from 'fs'

/**
 *   Directory structure of files that get created:
 *   paths["root"]/
 *       .hidden-folder/
 *           folder-in-hidden-folder/
 *               file.txt
 *       folder-a/
 *           .hidden-folder-in-folder-a/
 *               file.txt
 *           folder-b/
 *               folder-c/
 *                   search-item1.txt
 *                   extraSearch-item1.txt
 *                   extra-file-in-folder-c.txt
 *               folder-e/
 *       folder-d/
 *           search-item2.txt
 *           search-item3.txt
 *           search-item4.txt
 *           extraSearch-item2.txt
 *       folder-f/
 *           extraSearch-item3.txt
 *       folder-g/
 *       folder-h/
 *           amazing-item.txt
 *           folder-i/
 *               extraSearch-item4.txt
 *               extraSearch-item5.txt
 *           folder-j/
 *               folder-k/
 *                   lonely-file.txt
 *       .hidden-file.txt
 *       search-item5.txt
 */
export function setupPaths(): Record<string, string> {
  const paths = {}
  paths["root"] = path.join(__dirname, '_temp', 'search')
  paths['searchItem1Path'] = path.join(
    paths['root'],
    'folder-a',
    'folder-b',
    'folder-c',
    'search-item1.txt'
  )
  paths['searchItem2Path'] = path.join(
    paths['root'],
    'folder-d',
    'search-item2.txt'
  )
  paths['searchItem3Path'] = path.join(
    paths['root'],
    'folder-d',
    'search-item3.txt'
  )
  paths['searchItem4Path'] = path.join(
    paths['root'],
    'folder-d',
    'search-item4.txt'
  )
  paths['searchItem5Path'] = path.join(paths['root'], 'search-item5.txt')
  paths['extraSearchItem1Path'] = path.join(
    paths['root'],
    'folder-a',
    'folder-b',
    'folder-c',
    'extraSearch-item1.txt'
  )
  paths['extraSearchItem2Path'] = path.join(
    paths['root'],
    'folder-d',
    'extraSearch-item2.txt'
  )
  paths['extraSearchItem3Path'] = path.join(
    paths['root'],
    'folder-f',
    'extraSearch-item3.txt'
  )
  paths['extraSearchItem4Path'] = path.join(
    paths['root'],
    'folder-h',
    'folder-i',
    'extraSearch-item4.txt'
  )
  paths['extraSearchItem5Path'] = path.join(
    paths['root'],
    'folder-h',
    'folder-i',
    'extraSearch-item5.txt'
  )
  paths['extraFileInFolderCPath'] = path.join(
    paths['root'],
    'folder-a',
    'folder-b',
    'folder-c',
    'extra-file-in-folder-c.txt'
  )
  paths['amazingFileInFolderHPath'] = path.join(
    paths['root'],
    'folder-h',
    'amazing-item.txt'
  )
  paths['lonelyFilePath'] = path.join(
    paths['root'],
    'folder-h',
    'folder-j',
    'folder-k',
    'lonely-file.txt'
  )

  paths['hiddenFile'] = path.join(paths['root'], '.hidden-file.txt')
  paths['fileInHiddenFolderPath'] = path.join(
    paths['root'],
    '.hidden-folder',
    'folder-in-hidden-folder',
    'file.txt'
  )
  paths['fileInHiddenFolderInFolderA'] = path.join(
    paths['root'],
    'folder-a',
    '.hidden-folder-in-folder-a',
    'file.txt'
  )

  return paths
}

export async function recreateTestData(
  paths: Record<string, string>
): Promise<void> {
  // clear temp directory
  await io.rmRF(paths['root'])
  await fs.mkdir(path.join(paths['root'], 'folder-a', 'folder-b', 'folder-c'), {
    recursive: true
  })
  await fs.mkdir(path.join(paths['root'], 'folder-a', 'folder-b', 'folder-e'), {
    recursive: true
  })
  await fs.mkdir(path.join(paths['root'], 'folder-d'), {
    recursive: true
  })
  await fs.mkdir(path.join(paths['root'], 'folder-f'), {
    recursive: true
  })
  await fs.mkdir(path.join(paths['root'], 'folder-g'), {
    recursive: true
  })
  await fs.mkdir(path.join(paths['root'], 'folder-h', 'folder-i'), {
    recursive: true
  })
  await fs.mkdir(path.join(paths['root'], 'folder-h', 'folder-j', 'folder-k'), {
    recursive: true
  })

  await fs.mkdir(
    path.join(paths['root'], '.hidden-folder', 'folder-in-hidden-folder'),
    {recursive: true}
  )
  await fs.mkdir(
    path.join(paths['root'], 'folder-a', '.hidden-folder-in-folder-a'),
    {
      recursive: true
    }
  )

  await fs.writeFile(paths['searchItem1Path'], 'search item1 file')
  await fs.writeFile(paths['searchItem2Path'], 'search item2 file')
  await fs.writeFile(paths['searchItem3Path'], 'search item3 file')
  await fs.writeFile(paths['searchItem4Path'], 'search item4 file')
  await fs.writeFile(paths['searchItem5Path'], 'search item5 file')

  await fs.writeFile(paths['extraSearchItem1Path'], 'extraSearch item1 file')
  await fs.writeFile(paths['extraSearchItem2Path'], 'extraSearch item2 file')
  await fs.writeFile(paths['extraSearchItem3Path'], 'extraSearch item3 file')
  await fs.writeFile(paths['extraSearchItem4Path'], 'extraSearch item4 file')
  await fs.writeFile(paths['extraSearchItem5Path'], 'extraSearch item5 file')

  await fs.writeFile(paths['extraFileInFolderCPath'], 'extra file')

  await fs.writeFile(paths['amazingFileInFolderHPath'], 'amazing file')

  await fs.writeFile(paths['lonelyFilePath'], 'all by itself')

  await fs.writeFile(paths['hiddenFile'], 'hidden file')
  await fs.writeFile(
    paths['fileInHiddenFolderPath'],
    'file in hidden directory'
  )
  await fs.writeFile(
    paths['fileInHiddenFolderInFolderA'],
    'file in hidden directory'
  )
}
