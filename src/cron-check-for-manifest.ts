#!/usr/bin/env node

import fetch from 'cross-fetch';
import {
  DestinyCollectibleDefinition,
  DestinyDefinition,
  DestinyInventoryItemDefinition,
  DestinyLoreDefinition,
  DestinyPresentationNodeDefinition,
  DestinyRecordDefinition,
  getDestinyManifest,
} from 'bungie-api-ts/destiny2';
import { generateHttpClient } from '@d2api/manifest';
import latest from '../latest.json';
import fse from 'fs-extra';
import * as nodepub from 'nodepub';
import { pipeline } from 'stream';
import { promisify } from 'util';
import sharp from 'sharp';

const { writeFileSync } = fse;
const httpClient = generateHttpClient(fetch, process.env.API_KEY);

const skipCheck = process.env.SKIP_CHECK === 'true' ? true : false;

const fetchDefinition = async function (
  contentPaths: {
    [key: string]: {
      [key: string]: string;
    };
  },
  lang: string,
  definition: string
) {
  const path = contentPaths[lang][definition];
  const definitions = await fetch(`https://bungie.net${path}`)
    .then((res) => res.json())
    .then((body: { [hash: number]: DestinyDefinition }) => body);
  return definitions;
};

const downloadFile = async (
  url: string,
  path: string,
  resizePath?: string,
  width?: number,
  height?: number
) => {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`unexpected response ${response.statusText}`);
  const streamPipeline = promisify(pipeline);
  await streamPipeline(<any>response.body, fse.createWriteStream(path));

  if (resizePath && width && height) {
    await sharp(path).resize(width, height).toFile(resizePath);
  }
};

const prepImages = async function (
  metadata: NodepubMetadata,
  definitionTreeNode: DefinitionTreeNode
) {
  if (
    definitionTreeNode.type === 'DestinyPresentationNodeDefinition' &&
    definitionTreeNode.definition?.displayProperties.hasIcon
  ) {
    const splitPath = definitionTreeNode.definition.displayProperties.icon.split('/');
    const iconPath = splitPath[splitPath.length - 1];
    if (!fse.existsSync(`./assets/icons/${iconPath}`)) {
      await downloadFile(
        `https://bungie.net${definitionTreeNode.definition.displayProperties.icon}`,
        `./assets/icons/${iconPath}`
      );
    }
    if (fse.existsSync(`./assets/icons/${iconPath}`)) {
      metadata.images.push(`./assets/icons/${iconPath}`);
    }
  }
  if (definitionTreeNode.inventoryItemDefinition?.screenshot) {
    const splitPath = definitionTreeNode.inventoryItemDefinition.screenshot.split('/');
    const screenshotPath = splitPath[splitPath.length - 1];
    if (!fse.existsSync(`./assets/screenshots/${screenshotPath}`)) {
      await downloadFile(
        `https://bungie.net${definitionTreeNode.inventoryItemDefinition.screenshot}`,
        `./assets/screenshotsLarge/${screenshotPath}`,
        `./assets/screenshots/${screenshotPath}`,
        960,
        540
      );
    }
    if (fse.existsSync(`./assets/screenshots/${screenshotPath}`)) {
      metadata.images.push(`./assets/screenshots/${screenshotPath}`);
    }
  }
  for (const child of definitionTreeNode.childrenSorted) {
    await prepImages(metadata, child);
  }
};

const addSection = async function (epub: any, definitionTreeNode: DefinitionTreeNode) {
  let iconPath = '';
  let screenshotPath = '';
  if (
    definitionTreeNode.type === 'DestinyPresentationNodeDefinition' &&
    definitionTreeNode.definition?.displayProperties.hasIcon
  ) {
    const splitPath = definitionTreeNode.definition.displayProperties.icon.split('/');
    iconPath = splitPath[splitPath.length - 1];
  }
  if (definitionTreeNode.inventoryItemDefinition?.screenshot) {
    const splitPath = definitionTreeNode.inventoryItemDefinition?.screenshot.split('/');
    screenshotPath = splitPath[splitPath.length - 1];
  }
  const title = definitionTreeNode.definition?.displayProperties.name;

  let data = '';

  if (
    iconPath &&
    definitionTreeNode.type === 'DestinyPresentationNodeDefinition' &&
    fse.existsSync(`./assets/icons/${iconPath}`)
  ) {
    data = `${data}<img class="presentationNodeIcon" src="../images/${iconPath}" />`;
  }
  if (screenshotPath) {
    data = `${data}<img src="../images/${screenshotPath}" />`;
  }

  data = `${data}<h1 class="${definitionTreeNode.type}">${title}</h1>`;

  if (definitionTreeNode.definition?.displayProperties.description) {
    data = `${data}${definitionTreeNode.definition?.displayProperties.description
      .split('\n\n')
      .map((i) => `<p class="${definitionTreeNode.type}">${i}</p>`)
      .join('')
      .split('\n')
      .join('<br />')}`;
  }

  if (title && data) {
    epub.addSection(title, data);
  } // else console.log(loreItem);

  for (const child of definitionTreeNode.childrenSorted) {
    await addSection(epub, child);
  }
};

let contentsIndex = -1;

const appendContents = function (
  contents: string,
  definitionTreeNode: DefinitionTreeNode,
  links: NodepubContentsLink[]
) {
  contentsIndex++;
  const link = links[contentsIndex];
  if (definitionTreeNode.type === 'DestinyLoreDefinition') {
    return `${contents}<li><a href="${link.link}">${link.title}</a></li>`;
  } else {
    const listStart = `<ol>`;
    const listEnd = `</ol>`;
    contents =
      definitionTreeNode.definition && link
        ? `${contents}<li><a href="${link.link}">${link.title}</a></li>`
        : contents;
    contents = `${contents}${listStart}`;
    for (const child of definitionTreeNode.childrenSorted) {
      contents = appendContents(contents, child, links);
    }
    return `${contents}${listEnd}`;
  }
};

const sortChildren = function (definitionTreeNode: DefinitionTreeNode) {
  definitionTreeNode.childrenSorted = Array.from(definitionTreeNode.children).sort(
    (a, b) => <number>a.definition?.index - <number>b.definition?.index
  );
};

const reduceDepth = function (definitionTreeNode: DefinitionTreeNode) {
  if (
    definitionTreeNode.childrenSorted.length === 1 &&
    definitionTreeNode.childrenSorted[0].childrenSorted.length
  ) {
    definitionTreeNode.children = definitionTreeNode.childrenSorted[0].children;
    definitionTreeNode.childrenSorted = definitionTreeNode.childrenSorted[0].childrenSorted;
    sortChildren(definitionTreeNode);
    reduceDepth(definitionTreeNode);
    return;
  }
  if (definitionTreeNode.type === 'DestinyPresentationNodeDefinition') {
    for (const child of definitionTreeNode.childrenSorted) {
      if (
        child.type === 'DestinyPresentationNodeDefinition' &&
        !child.definition?.displayProperties.hasIcon
      ) {
        for (const gc of child.childrenSorted) {
          definitionTreeNode.children.add(gc);
        }
        definitionTreeNode.children.delete(child);
        sortChildren(definitionTreeNode);
        reduceDepth(definitionTreeNode);
        return;
      }
    }
  }
  for (const child of definitionTreeNode.childrenSorted) {
    reduceDepth(child);
  }
};

let definitionTreeRootNode: DefinitionTreeNode = {
  key: -1,
  type: 'DestinyPresentationNodeDefinition',
  children: new Set(),
  childrenSorted: [],
};

const makeContentsPage = function (links: NodepubContentsLink[]) {
  let contents = '<h1>Chapters</h1>';
  if (definitionTreeRootNode) {
    contents = appendContents(contents, definitionTreeRootNode, links);
  }
  return contents;
};

const generateEpub = async function (
  contentPaths: {
    [key: string]: {
      [key: string]: string;
    };
  },
  lang: string
) {
  const lore = (await fetchDefinition(contentPaths, lang, 'DestinyLoreDefinition')) as {
    [hash: number]: DestinyLoreDefinition;
  };
  const presentationNodes = (await fetchDefinition(
    contentPaths,
    lang,
    'DestinyPresentationNodeDefinition'
  )) as { [hash: number]: DestinyPresentationNodeDefinition };
  const records = (await fetchDefinition(contentPaths, lang, 'DestinyRecordDefinition')) as {
    [hash: number]: DestinyRecordDefinition;
  };
  const collectibles = (await fetchDefinition(
    contentPaths,
    lang,
    'DestinyCollectibleDefinition'
  )) as {
    [hash: number]: DestinyCollectibleDefinition;
  };
  const inventoryItems = (await fetchDefinition(
    contentPaths,
    lang,
    'DestinyInventoryItemDefinition'
  )) as {
    [hash: number]: DestinyInventoryItemDefinition;
  };

  const presentationNodeKeys = Object.keys(presentationNodes);
  presentationNodeKeys.sort(
    (a, b) => presentationNodes[Number(a)].index - presentationNodes[Number(b)].index
  );

  for (const key of presentationNodeKeys) {
    const node = presentationNodes[Number(key)];
    if (
      node.parentNodeHashes.length ||
      (!node.children.presentationNodes.length &&
        !node.children.collectibles.length &&
        !node.children.records.length)
    ) {
      continue;
    }
  }

  const definitionTreeNodeArray: DefinitionTreeNode[] = [];

  const recordKeys = Object.keys(records);
  recordKeys.sort((a, b) => records[Number(a)].index - records[Number(b)].index);

  for (const key of recordKeys) {
    const node = records[Number(key)];
    if (!node.loreHash) {
      continue;
    }
    const loreNode = lore[node.loreHash];
    const filtered = definitionTreeNodeArray.filter(
      (n) =>
        n.key === node.loreHash ||
        n.definition?.displayProperties.description === loreNode.displayProperties.description
    );
    if (!filtered.length) {
      let currentDefinitionTreeNode: DefinitionTreeNode = {
        key: node.loreHash,
        type: 'DestinyLoreDefinition',
        definition: loreNode,
        children: new Set(),
        childrenSorted: [],
      };
      definitionTreeNodeArray.push(currentDefinitionTreeNode);
      let currentNode: DestinyRecordDefinition | DestinyPresentationNodeDefinition = node;
      while (currentNode.parentNodeHashes.length) {
        const parentNode: DestinyPresentationNodeDefinition =
          presentationNodes[Number(currentNode.parentNodeHashes[0])];
        if (!definitionTreeNodeArray.filter((n) => n.key === parentNode.hash).length) {
          definitionTreeNodeArray.push({
            key: parentNode.hash,
            type: 'DestinyPresentationNodeDefinition',
            definition: parentNode,
            children: new Set(),
            childrenSorted: [],
          });
        }
        const parentDefinitionTreeNode = definitionTreeNodeArray.filter(
          (n) => n.key === parentNode.hash
        )[0];
        parentDefinitionTreeNode.children.add(currentDefinitionTreeNode);
        sortChildren(parentDefinitionTreeNode);
        currentNode = parentNode;
        currentDefinitionTreeNode = parentDefinitionTreeNode;
      }
      definitionTreeRootNode.children.add(currentDefinitionTreeNode);
      sortChildren(definitionTreeRootNode);
    }
  }

  const collectibleKeys = Object.keys(collectibles);
  collectibleKeys.sort((a, b) => collectibles[Number(a)].index - collectibles[Number(b)].index);

  for (const key of collectibleKeys) {
    const node = collectibles[Number(key)];
    if (!node.itemHash) {
      continue;
    }
    const inventoryItemNode = inventoryItems[node.itemHash];
    if (!inventoryItemNode.loreHash) {
      continue;
    }
    const loreNode = lore[inventoryItemNode.loreHash];
    const filtered = definitionTreeNodeArray.filter(
      (n) =>
        n.key === inventoryItemNode.loreHash ||
        n.definition?.displayProperties.description === loreNode.displayProperties.description
    );
    if (!filtered.length) {
      let currentDefinitionTreeNode: DefinitionTreeNode = {
        key: inventoryItemNode.loreHash,
        type: 'DestinyLoreDefinition',
        definition: loreNode,
        inventoryItemDefinition: inventoryItemNode,
        children: new Set(),
        childrenSorted: [],
      };
      definitionTreeNodeArray.push(currentDefinitionTreeNode);
      let currentNode: DestinyCollectibleDefinition | DestinyPresentationNodeDefinition = node;
      while (currentNode.parentNodeHashes.length) {
        const parentNode: DestinyPresentationNodeDefinition =
          presentationNodes[Number(currentNode.parentNodeHashes[0])];
        if (!definitionTreeNodeArray.filter((n) => n.key === parentNode.hash).length) {
          definitionTreeNodeArray.push({
            key: parentNode.hash,
            type: 'DestinyPresentationNodeDefinition',
            definition: parentNode,
            children: new Set(),
            childrenSorted: [],
          });
        }
        const parentDefinitionTreeNode = definitionTreeNodeArray.filter(
          (n) => n.key === parentNode.hash
        )[0];
        parentDefinitionTreeNode.children.add(currentDefinitionTreeNode);
        sortChildren(parentDefinitionTreeNode);
        currentNode = parentNode;
        currentDefinitionTreeNode = parentDefinitionTreeNode;
      }
      definitionTreeRootNode.children.add(currentDefinitionTreeNode);
      sortChildren(definitionTreeRootNode);
    }
  }

  reduceDepth(definitionTreeRootNode);

  const date = new Date();

  const metadata: NodepubMetadata = {
    id: '0',
    cover: './assets/cover.jpg',
    genre: 'Science Fiction',
    title: 'Grimoire',
    author: 'Bungie',
    language: lang,
    contents: 'Table of Contents',
    source: 'https://www.bungie.net',
    published: `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`,
    description: 'The Destiny 2 Grimoire',
    images: [],
  };

  await prepImages(metadata, definitionTreeRootNode);

  const epub = nodepub.document(metadata, makeContentsPage);

  epub.addCSS(
    `.presentationNodeIcon { text-align: center; margin-top: 20%; margin-left: 40%; width: 20%; } .DestinyPresentationNodeDefinition { text-align: center; }`
  );

  await addSection(epub, definitionTreeRootNode);

  await epub.writeEPUB('./epub', `grimoire-${lang}`);
};

// do the thing
(async () => {
  const manifestMetadata = await getDestinyManifest(httpClient);

  const current = manifestMetadata.Response.version;
  let newREADME = `# d2-grimoire-epub\ngithub action for generating grimoire epub files when the d2 manifest is updated\n\n Current Manifest: ${current}\n\n# Downloads\n\n`;

  if (!skipCheck) {
    console.log(`Latest:  ${latest}`);
    console.log(`Current: ${current}`);
    if (latest === current) {
      // nothing changed. no updates needed.
      return;
    }
    // if you are here, there's a new manifest
    console.log('New manifest detected');
  }

  fse.emptyDirSync('./assets/icons');
  fse.emptyDirSync('./assets/screenshotsLarge');
  fse.emptyDirSync('./assets/screenshots');
  fse.emptyDirSync('./epub');

  const contentPaths = manifestMetadata.Response.jsonWorldComponentContentPaths;
  for (const lang of Object.keys(contentPaths)) {
    definitionTreeRootNode = {
      key: -1,
      type: 'DestinyPresentationNodeDefinition',
      children: new Set(),
      childrenSorted: [],
    };
    contentsIndex = -1;
    await generateEpub(contentPaths, lang);
    newREADME = `${newREADME}- [grimoire-${lang}.epub](https://github.com/chrisfried/d2-grimoire-epub/raw/master/epub/grimoire-${lang}.epub)\n`;
  }
  writeFileSync('latest.json', `${JSON.stringify(current, null, 2)}\n`, 'utf8');
  writeFileSync('README.md', newREADME, 'utf8');

  // if (!/^[.\w-]+$/.test(versionNumber)) { I AM NOT REALLY SURE THIS NEEDS DOING. }
})().catch((e) => {
  console.log(e);
  process.exit(1);
});

interface DefinitionTreeNode {
  key: number;
  type: 'DestinyLoreDefinition' | 'DestinyPresentationNodeDefinition';
  definition?: DestinyLoreDefinition | DestinyPresentationNodeDefinition;
  inventoryItemDefinition?: DestinyInventoryItemDefinition;
  children: Set<DefinitionTreeNode>;
  childrenSorted: DefinitionTreeNode[];
}

interface NodepubMetadata {
  id: string;
  cover: string;
  title: string;
  series?: string;
  sequence?: number;
  author: string;
  fileAs?: string;
  genre: string;
  tags?: string;
  copyright?: string;
  publisher?: string;
  published: string;
  language: string;
  description?: string;
  contents: string;
  source: string;
  images: string[];
}

interface NodepubContentsLink {
  title: string;
  link: string;
  itemType: 'front' | 'contents' | 'main';
}
