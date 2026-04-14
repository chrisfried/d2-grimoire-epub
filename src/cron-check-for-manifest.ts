#!/usr/bin/env node

import 'dotenv/config';
import {
  DestinyCollectibleDefinition,
  DestinyDefinition,
  DestinyInventoryItemDefinition,
  DestinyLoreDefinition,
  DestinyPresentationNodeDefinition,
  DestinyRecordDefinition,
  DestinySeasonDefinition,
  getDestinyManifest,
} from 'bungie-api-ts/destiny2';
import { HttpClient, HttpClientConfig } from 'bungie-api-ts/http';
import { load, setApiKey, allManifest, setLanguage, includeTables } from '@d2api/manifest-node';
import latest from '../latest.json' with { type: 'json' };
import fse from 'fs-extra';
import * as nodepub from 'nodepub';
import { pipeline } from 'stream';
import { promisify } from 'util';
import sharp from 'sharp';
import {
  buildLoreToSeasonMap,
  buildItemToSeasonMap,
  groupLoreBySeason,
  getAllSeasons,
  findUnmappedLoreBooks,
  D2CalculatedSeason,
  type SeasonInfo,
} from './season-mapping.js';

const { writeFileSync } = fse;

// Translations for UI strings
const translations: Record<string, Record<string, string>> = {
  en: {
    grimoire: 'Destiny 2 Grimoire',
    unmappedContent: 'Unmapped Content',
    season: 'Season',
    released: 'Released',
    books: 'Books',
    items: 'Items',
    chapters: 'Chapters',
    titlePage: 'Title Page',
  },
  fr: {
    grimoire: 'Grimoire de Destiny 2',
    unmappedContent: 'Contenu non classé',
    season: 'Saison',
    released: 'Sortie',
    books: 'Livres',
    items: 'Objets',
    chapters: 'Chapitres',
    titlePage: 'Page de titre',
  },
  es: {
    grimoire: 'Grimorio de Destiny 2',
    unmappedContent: 'Contenido sin clasificar',
    season: 'Temporada',
    released: 'Lanzamiento',
    books: 'Libros',
    items: 'Objetos',
    chapters: 'Capítulos',
    titlePage: 'Portada',
  },
  'es-mx': {
    grimoire: 'Grimorio de Destiny 2',
    unmappedContent: 'Contenido sin clasificar',
    season: 'Temporada',
    released: 'Lanzamiento',
    books: 'Libros',
    items: 'Objetos',
    chapters: 'Capítulos',
    titlePage: 'Portada',
  },
  de: {
    grimoire: 'Destiny 2 Grimoire',
    unmappedContent: 'Nicht zugeordnete Inhalte',
    season: 'Saison',
    released: 'Veröffentlicht',
    books: 'Bücher',
    items: 'Gegenstände',
    chapters: 'Kapitel',
    titlePage: 'Titelseite',
  },
  it: {
    grimoire: 'Grimorio di Destiny 2',
    unmappedContent: 'Contenuto non classificato',
    season: 'Stagione',
    released: 'Rilasciato',
    books: 'Libri',
    items: 'Oggetti',
    chapters: 'Capitoli',
    titlePage: 'Pagina del titolo',
  },
  ja: {
    grimoire: 'Destiny 2 グリモア',
    unmappedContent: '未分類コンテンツ',
    season: 'シーズン',
    released: 'リリース日',
    books: '書籍',
    items: 'アイテム',
    chapters: '章',
    titlePage: 'タイトルページ',
  },
  'pt-br': {
    grimoire: 'Grimório de Destiny 2',
    unmappedContent: 'Conteúdo não mapeado',
    season: 'Temporada',
    released: 'Lançamento',
    books: 'Livros',
    items: 'Itens',
    chapters: 'Capítulos',
    titlePage: 'Página de título',
  },
  ru: {
    grimoire: 'Гримуар Destiny 2',
    unmappedContent: 'Неклассифицированный контент',
    season: 'Сезон',
    released: 'Дата выхода',
    books: 'Книги',
    items: 'Предметы',
    chapters: 'Главы',
    titlePage: 'Титульная страница',
  },
  pl: {
    grimoire: 'Grimorium Destiny 2',
    unmappedContent: 'Niesklasyfikowana zawartość',
    season: 'Sezon',
    released: 'Data wydania',
    books: 'Książki',
    items: 'Przedmioty',
    chapters: 'Rozdziały',
    titlePage: 'Strona tytułowa',
  },
  ko: {
    grimoire: 'Destiny 2 그리무아르',
    unmappedContent: '미분류 콘텐츠',
    season: '시즌',
    released: '출시일',
    books: '도서',
    items: '아이템',
    chapters: '챕터',
    titlePage: '표지',
  },
  'zh-chs': {
    grimoire: 'Destiny 2 宝典',
    unmappedContent: '未分类内容',
    season: '赛季',
    released: '发布日期',
    books: '书籍',
    items: '物品',
    chapters: '章节',
    titlePage: '扉页',
  },
  'zh-cht': {
    grimoire: 'Destiny 2 寶典',
    unmappedContent: '未分類內容',
    season: '賽季',
    released: '發佈日期',
    books: '書籍',
    items: '物品',
    chapters: '章節',
    titlePage: '扉頁',
  },
};

const getTranslation = (lang: string, key: string): string => {
  return translations[lang]?.[key] || translations['en'][key] || key;
};

// Current language for makeContentsPage callback
let currentLanguage = 'en';

const apiKey = process.env.API_KEY;
if (!apiKey) {
  throw new Error('API_KEY environment variable is required');
}

setApiKey(apiKey);

// Configure which tables to load
includeTables(['Lore', 'PresentationNode', 'Record', 'Collectible', 'InventoryItem', 'Season']);

const $http: HttpClient = async <T>(config: HttpClientConfig): Promise<T> => {
  const url = new URL(config.url);
  if (config.params) {
    Object.entries(config.params).forEach(([key, value]) => {
      if (value !== undefined) {
        url.searchParams.append(key, String(value));
      }
    });
  }

  const headers: Record<string, string> = {
    'X-API-Key': apiKey,
  };

  const response = await fetch(url.toString(), {
    method: config.method || 'GET',
    headers,
    body: config.body ? JSON.stringify(config.body) : undefined,
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  return (await response.json()) as T;
};

const skipCheck = process.env.SKIP_CHECK === 'true';

// Map full definition names to short table names
const definitionNameMap: Record<string, string> = {
  DestinyLoreDefinition: 'Lore',
  DestinyPresentationNodeDefinition: 'PresentationNode',
  DestinyRecordDefinition: 'Record',
  DestinyCollectibleDefinition: 'Collectible',
  DestinyInventoryItemDefinition: 'InventoryItem',
};

const fetchDefinition = async function <T extends DestinyDefinition>(
  _contentPaths: {
    [key: string]: {
      [key: string]: string;
    };
  },
  lang: string,
  definition: string,
): Promise<{ [hash: number]: T }> {
  setLanguage(lang as any);
  const shortName = definitionNameMap[definition] || definition;
  // Access the component from allManifest
  const component = allManifest?.[shortName as keyof typeof allManifest];
  if (!component) {
    throw new Error(`Component ${shortName} not found in manifest`);
  }
  return component as { [hash: number]: T };
};

const downloadFile = async (
  url: string,
  path: string,
  resizePath?: string,
  width?: number,
  height?: number,
) => {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: ${response.statusText}`);
  }
  const streamPipeline = promisify(pipeline);
  await streamPipeline(response.body as any, fse.createWriteStream(path));

  if (resizePath && width && height) {
    await sharp(path).resize(width, height).toFile(resizePath);
  }
};

/**
 * Extract armor set name from item name
 * Destiny 2 armor typically follows patterns like:
 * - "Helm/Hood/Mask of the Great Hunt" -> "Great Hunt"
 * - "Ancient Apocalypse Helm/Hood/Mask" -> "Ancient Apocalypse"
 * - "Reverie Dawn Helm/Hood/Mask" -> "Reverie Dawn"
 */
const extractArmorSetPrefix = (itemName: string): string => {
  // Pattern 1: "X of the/of Y" (e.g., "Helm of the Great Hunt" -> "Great Hunt")
  const ofTheMatch = itemName.match(
    /^(?:Helm|Hood|Mask|Casque|Crown|Cap|Gauntlets|Gloves|Grips|Arms|Grasps|Wraps|Chest|Plate|Robes|Vest|Cuirass|Hauberk|Greaves|Boots|Strides|Treads|Steps|Legs|Mark|Bond|Cloak|Cape)\s+of\s+(?:the\s+)?(.+)$/i,
  );
  if (ofTheMatch) {
    return ofTheMatch[1].trim();
  }

  // Pattern 2: "Set Name Piece" (e.g., "Ancient Apocalypse Helm" -> "Ancient Apocalypse")
  const armorSuffixes = [
    ' Helm',
    ' Helmet',
    ' Hood',
    ' Mask',
    ' Casque',
    ' Crown',
    ' Cap',
    ' Gauntlets',
    ' Gloves',
    ' Grips',
    ' Arms',
    ' Grasps',
    ' Wraps',
    ' Chest',
    ' Plate',
    ' Robes',
    ' Vest',
    ' Cuirass',
    ' Hauberk',
    ' Greaves',
    ' Boots',
    ' Strides',
    ' Treads',
    ' Steps',
    ' Legs',
    ' Mark',
    ' Bond',
    ' Cloak',
    ' Cape',
  ];

  for (const suffix of armorSuffixes) {
    if (itemName.endsWith(suffix)) {
      return itemName.slice(0, -suffix.length).trim();
    }
  }

  // If no suffix found, return the full name (might be a unique piece)
  return itemName;
};

const prepImages = async function (
  metadata: nodepub.Metadata,
  definitionTreeNode: DefinitionTreeNode,
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
        `./assets/icons/${iconPath}`,
      ).catch((err) =>
        console.log(
          `Error downloading icon for ${definitionTreeNode.definition?.displayProperties.name}`,
        ),
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
        540,
      ).catch(() => {});
    }
    if (fse.existsSync(`./assets/screenshots/${screenshotPath}`)) {
      metadata.images.push(`./assets/screenshots/${screenshotPath}`);
    }
  }
  // Handle batched items - download screenshots for all items in the batch
  if (definitionTreeNode.type === 'BatchedItems' && definitionTreeNode.batchedItems) {
    for (const catItem of definitionTreeNode.batchedItems) {
      if (catItem.item.screenshot) {
        const splitPath = catItem.item.screenshot.split('/');
        const screenshotPath = splitPath[splitPath.length - 1];
        if (!fse.existsSync(`./assets/screenshots/${screenshotPath}`)) {
          await downloadFile(
            `https://bungie.net${catItem.item.screenshot}`,
            `./assets/screenshotsLarge/${screenshotPath}`,
            `./assets/screenshots/${screenshotPath}`,
            960,
            540,
          ).catch(() => {});
        }
        if (fse.existsSync(`./assets/screenshots/${screenshotPath}`)) {
          metadata.images.push(`./assets/screenshots/${screenshotPath}`);
        }
      }
    }
  }
  // Handle source items - download screenshots for all items in the source
  if (definitionTreeNode.type === 'Source' && definitionTreeNode.sourceItems) {
    for (const catItem of definitionTreeNode.sourceItems) {
      if (catItem.item.screenshot) {
        const splitPath = catItem.item.screenshot.split('/');
        const screenshotPath = splitPath[splitPath.length - 1];
        if (!fse.existsSync(`./assets/screenshots/${screenshotPath}`)) {
          await downloadFile(
            `https://bungie.net${catItem.item.screenshot}`,
            `./assets/screenshotsLarge/${screenshotPath}`,
            `./assets/screenshots/${screenshotPath}`,
            960,
            540,
          ).catch(() => {});
        }
        if (fse.existsSync(`./assets/screenshots/${screenshotPath}`)) {
          metadata.images.push(`./assets/screenshots/${screenshotPath}`);
        }
      }
    }
  }
  for (const child of definitionTreeNode.childrenSorted) {
    await prepImages(metadata, child);
  }
};

const sortChildren = function (definitionTreeNode: DefinitionTreeNode) {
  definitionTreeNode.childrenSorted = Array.from(definitionTreeNode.children).sort((a, b) =>
    a.collectibleDefinition && b.collectibleDefinition
      ? a.collectibleDefinition?.index - b.collectibleDefinition?.index
      : <number>a.definition?.index - <number>b.definition?.index,
  );
};

const addSection = async function (epub: nodepub.Document, definitionTreeNode: DefinitionTreeNode) {
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

  // Handle BatchedItems (armor sets, exotics, legendaries, items without lore)
  if (definitionTreeNode.type === 'BatchedItems' && definitionTreeNode.batchedItems) {
    let batchContent = '';
    batchContent += `<h1>${title}</h1>`;

    // Sort batched items by collectible index
    const sortedItems = [...definitionTreeNode.batchedItems].sort(
      (a, b) => (a.collectible.index || 0) - (b.collectible.index || 0),
    );

    for (let i = 0; i < sortedItems.length; i++) {
      const catItem = sortedItems[i];
      const itemName = catItem.item.displayProperties?.name || 'Unknown Item';

      // Start item entry container
      batchContent += `<div class="item-entry">`;

      // Add screenshot if available (floated left)
      if (catItem.item.screenshot) {
        const splitPath = catItem.item.screenshot.split('/');
        const itemScreenshotPath = splitPath[splitPath.length - 1];
        if (fse.existsSync(`./assets/screenshots/${itemScreenshotPath}`)) {
          batchContent += `<img src="../images/${itemScreenshotPath}" />`;
        }
      }

      // Add item name
      batchContent += `<h2>${itemName}</h2>`;

      // Add flavor text if available
      if (catItem.item.flavorText && catItem.item.flavorText.trim().length > 0) {
        batchContent += `<div class="flavor-text"><em>${catItem.item.flavorText
          .split('\n\n')
          .map((i: string) => `<p>${i}</p>`)
          .join('')
          .split('\n')
          .join('<br />')}</em></div>`;
      }

      batchContent += `</div>`; // Close item-entry

      // Add lore content if available (below the image/title block)
      if (catItem.lore?.displayProperties?.description) {
        batchContent += `<div class="item-lore">`;
        batchContent += catItem.lore.displayProperties.description
          .split('\n\n')
          .map((i: string) => `<p>${i}</p>`)
          .join('')
          .split('\n')
          .join('<br />');
        batchContent += `</div>`;
      }
    }

    if (batchContent && title) {
      epub.addSection(title, batchContent);
    }
    return; // Batched items don't have children to process
  }

  // Handle Source nodes - combine all items into a single chapter
  if (definitionTreeNode.type === 'Source' && definitionTreeNode.sourceItems) {
    let sourceContent = '';
    sourceContent += `<h1>${title}</h1>`;

    // Sort items by collectible index
    const sortedItems = [...definitionTreeNode.sourceItems].sort(
      (a, b) => (a.collectible.index || 0) - (b.collectible.index || 0),
    );

    for (let i = 0; i < sortedItems.length; i++) {
      const catItem = sortedItems[i];
      const itemName = catItem.item.displayProperties?.name || 'Unknown Item';

      // Start item entry container
      sourceContent += `<div class="item-entry">`;

      // Add screenshot if available (floated left)
      if (catItem.item.screenshot) {
        const splitPath = catItem.item.screenshot.split('/');
        const itemScreenshotPath = splitPath[splitPath.length - 1];
        if (fse.existsSync(`./assets/screenshots/${itemScreenshotPath}`)) {
          sourceContent += `<img src="../images/${itemScreenshotPath}" />`;
        }
      }

      // Add item name
      sourceContent += `<h2>${itemName}</h2>`;

      // Add flavor text if available
      if (catItem.item.flavorText && catItem.item.flavorText.trim().length > 0) {
        sourceContent += `<div class="flavor-text"><em>${catItem.item.flavorText
          .split('\n\n')
          .map((i: string) => `<p>${i}</p>`)
          .join('')
          .split('\n')
          .join('<br />')}</em></div>`;
      }

      sourceContent += `</div>`; // Close item-entry

      // Add lore content if available (below the image/title block)
      if (catItem.lore?.displayProperties?.description) {
        sourceContent += `<div class="item-lore">`;
        sourceContent += catItem.lore.displayProperties.description
          .split('\n\n')
          .map((i: string) => `<p>${i}</p>`)
          .join('')
          .split('\n')
          .join('<br />');
        sourceContent += `</div>`;
      }
    }

    if (sourceContent && title) {
      epub.addSection(title, sourceContent);
    }
    return; // Source nodes don't have children to process
  }

  // Check if this is a lore book (presentation node with lore children)
  const isLoreBook =
    definitionTreeNode.type === 'DestinyPresentationNodeDefinition' &&
    definitionTreeNode.childrenSorted.length > 0 &&
    definitionTreeNode.childrenSorted.every((child) => child.type === 'DestinyLoreDefinition');

  if (isLoreBook) {
    // For lore books, combine all entries into a single section with separators
    let bookContent = '';

    // Add book icon if available
    if (iconPath && fse.existsSync(`./assets/icons/${iconPath}`)) {
      bookContent += `<img class="presentationNodeIcon" src="../images/${iconPath}" />`;
    }

    bookContent += `<h1>${title}</h1>`;

    // Add book description if available
    if (definitionTreeNode.definition?.displayProperties.description) {
      bookContent += definitionTreeNode.definition.displayProperties.description
        .split('\n\n')
        .map((i) => `<p>${i}</p>`)
        .join('')
        .split('\n')
        .join('<br />');
    }

    // Add each lore entry
    for (let i = 0; i < definitionTreeNode.childrenSorted.length; i++) {
      const child = definitionTreeNode.childrenSorted[i];
      const entryTitle = child.definition?.displayProperties.name;

      bookContent += `<h2>${entryTitle}</h2>`;

      // Add flavor text if available
      if (child.inventoryItemDefinition?.flavorText) {
        const flavorText = child.inventoryItemDefinition.flavorText;
        bookContent += `<div class="flavor-text"><em>${flavorText
          .split('\n\n')
          .map((i) => `<p>${i}</p>`)
          .join('')
          .split('\n')
          .join('<br />')}</em></div>`;
      }

      // Add lore content
      if (child.definition?.displayProperties.description) {
        bookContent += child.definition.displayProperties.description
          .split('\n\n')
          .map((i) => `<p>${i}</p>`)
          .join('')
          .split('\n')
          .join('<br />');
      }
    }

    if (bookContent && title) {
      epub.addSection(title, bookContent);
    }
    return; // Don't process children individually
  }

  // For non-lore-book nodes, display normally
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

  // For lore entries, show the item's flavor text first
  if (
    definitionTreeNode.type === 'DestinyLoreDefinition' &&
    definitionTreeNode.inventoryItemDefinition
  ) {
    const flavorText = definitionTreeNode.inventoryItemDefinition.flavorText;
    if (flavorText && flavorText.trim().length > 0) {
      data = `${data}<div class="flavor-text"><em>${flavorText
        .split('\n\n')
        .map((i) => `<p>${i}</p>`)
        .join('')
        .split('\n')
        .join('<br />')}</em></div>`;
    }
  }

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
  }

  sortChildren(definitionTreeNode);

  // Process children normally
  for (const child of definitionTreeNode.childrenSorted) {
    await addSection(epub, child);
  }
};

let contentsIndex = -1;

const appendContents = function (
  contents: string,
  definitionTreeNode: DefinitionTreeNode,
  links: nodepub.ContentsLink[],
) {
  contentsIndex++;
  const link = links[contentsIndex];

  // Check if this is a lore book (presentation node with all lore children)
  const isLoreBook =
    definitionTreeNode.type === 'DestinyPresentationNodeDefinition' &&
    definitionTreeNode.childrenSorted.length > 0 &&
    definitionTreeNode.childrenSorted.every((child) => child.type === 'DestinyLoreDefinition');

  // Check if this is a batched items node or a source node
  const isBatchedItems = definitionTreeNode.type === 'BatchedItems';
  const isSource = definitionTreeNode.type === 'Source';

  if (definitionTreeNode.type === 'DestinyLoreDefinition' && link) {
    return `${contents}<li><a href="${link.link}">${link.title}</a></li>`;
  } else if ((isLoreBook || isBatchedItems || isSource) && link) {
    // For lore books, batched items, and sources, just add the single ToC entry - don't recurse
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

let definitionTreeRootNode: DefinitionTreeNode = {
  key: -1,
  type: 'DestinyPresentationNodeDefinition',
  children: new Set(),
  childrenSorted: [],
};

const makeContentsPage = function (links: nodepub.ContentsLink[]) {
  let contents = `<h1>${getTranslation(currentLanguage, 'chapters')}</h1>`;
  if (definitionTreeRootNode) {
    contents = appendContents(contents, definitionTreeRootNode, links);
  }
  return contents;
};

/**
 * Simple hash function for content deduplication
 */
const hashContent = (str: string): string => {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash.toString(16);
};

/**
 * Item categorization for batching
 */
interface CategorizedItem {
  item: DestinyInventoryItemDefinition;
  collectible: DestinyCollectibleDefinition;
  lore?: DestinyLoreDefinition;
  hasLore: boolean;
  isArmor: boolean;
  isExotic: boolean;
  armorSetName?: string;
}

/**
 * Get armor set name from item
 */
const getArmorSetName = (item: DestinyInventoryItemDefinition): string | undefined => {
  // Try setData first
  if (item.setData?.questLineName) {
    return item.setData.questLineName;
  }
  // Try itemTypeDisplayName (e.g., "Titan Helmet" -> need to look at broader context)
  // For Destiny, armor sets often share a common prefix in their names
  // But the most reliable way is to group by collection/source + tier
  return undefined;
};

interface SeasonStats {
  bookCount: number;
  bookEntryCount: number;
  itemCount: number;
  itemsWithLore: number;
  itemsFlavorOnly: number;
}

/**
 * Generate an EPUB for a specific season
 */
const generateSeasonEpub = async function (
  contentPaths: {
    [key: string]: {
      [key: string]: string;
    };
  },
  lang: string,
  seasonInfo: SeasonInfo,
  loreHashes: number[],
  inventoryItems: { [hash: number]: DestinyInventoryItemDefinition },
  collectibles: { [hash: number]: DestinyCollectibleDefinition },
  presentationNodes: { [hash: number]: DestinyPresentationNodeDefinition },
  records: { [hash: number]: DestinyRecordDefinition },
  lore: { [hash: number]: DestinyLoreDefinition },
  seasons: { [hash: number]: DestinySeasonDefinition },
  itemToSeasonMap: Map<number, number>,
  outputFolder: string,
): Promise<SeasonStats> {
  // Get localized season name from manifest
  const seasonDef = Object.values(seasons).find((s) => s.seasonNumber === seasonInfo.season);
  const localizedSeasonName = seasonDef?.displayProperties?.name || seasonInfo.seasonName;

  // Filter lore to only include those with non-empty text
  const validLoreHashes = new Set(
    loreHashes.filter((loreHash) => {
      const loreEntry = lore[loreHash];
      return loreEntry && loreEntry.displayProperties?.description?.trim().length > 0;
    }),
  );

  // Track content hashes for deduplication
  const seenContentHashes = new Set<string>();

  // Track which lore hashes come from collectibles (items)
  const collectibleLoreHashes = new Set<number>();

  // Collect ALL items from season (not just those with loreHash)
  // Items need: collectible with valid item, and either lore OR flavor text
  const allSeasonItems: CategorizedItem[] = [];

  for (const collectible of Object.values(collectibles)) {
    if (!collectible.itemHash) continue;

    const item = inventoryItems[collectible.itemHash];
    if (!item) continue;

    // Get lore if item has it and it's in our valid set
    const loreEntry =
      item.loreHash && validLoreHashes.has(item.loreHash) ? lore[item.loreHash] : undefined;
    const hasLore = !!loreEntry;
    const hasFlavorText = !!(item.flavorText && item.flavorText.trim().length > 0);

    // Skip items with neither lore nor flavor text
    if (!hasLore && !hasFlavorText) continue;

    // Check if this item belongs to the current season
    if (hasLore) {
      // For items with lore: lore must be in validLoreHashes (already season-filtered)
      if (!validLoreHashes.has(item.loreHash!)) continue;
    } else {
      // For flavor-text-only items: check item's season via itemToSeasonMap
      const itemSeason = itemToSeasonMap.get(item.hash);
      if (itemSeason !== seasonInfo.season) continue;
    }

    // Content deduplication
    const contentKey = `${item.flavorText || ''}|${loreEntry?.displayProperties?.description || ''}`;
    const contentHash = hashContent(contentKey);
    if (seenContentHashes.has(contentHash)) continue;
    seenContentHashes.add(contentHash);

    // Categorize the item
    const isArmor = item.itemType === 2; // DestinyItemType.Armor = 2
    const isExotic = item.inventory?.tierType === 6 || item.inventory?.tierTypeName === 'Exotic';

    const categorizedItem: CategorizedItem = {
      item,
      collectible,
      lore: loreEntry,
      hasLore,
      isArmor,
      isExotic,
      armorSetName: isArmor ? getArmorSetName(item) : undefined,
    };

    allSeasonItems.push(categorizedItem);

    if (hasLore) {
      collectibleLoreHashes.add(item.loreHash!);
    }
  }

  // Count items by type for logging
  const itemsWithLore = allSeasonItems.filter((i) => i.hasLore).length;
  const itemsFlavorOnly = allSeasonItems.filter((i) => !i.hasLore).length;

  // Group items by source, then further categorize within each source
  const sourceGroups = new Map<
    string,
    {
      sourceName: string;
      armorSets: Map<string, CategorizedItem[]>; // set name -> armor pieces
      exotics: CategorizedItem[];
      legendariesWithLore: CategorizedItem[];
      itemsWithoutLore: CategorizedItem[];
    }
  >();

  for (const catItem of allSeasonItems) {
    // Use collectible source string for grouping
    const sourceKey =
      catItem.collectible.sourceString || `Source ${catItem.collectible.sourceHash || 0}`;

    if (!sourceGroups.has(sourceKey)) {
      sourceGroups.set(sourceKey, {
        sourceName: sourceKey,
        armorSets: new Map(),
        exotics: [],
        legendariesWithLore: [],
        itemsWithoutLore: [],
      });
    }

    const group = sourceGroups.get(sourceKey)!;

    // Categorization priority: Exotics first (even exotic armor goes into Exotics batch),
    // then legendary armor into armor sets, then other categorizations
    if (catItem.isExotic) {
      // All exotics (weapons AND armor) go into the Exotics batch
      group.exotics.push(catItem);
    } else if (catItem.isArmor) {
      // Group non-exotic armor by set name
      const setName =
        catItem.armorSetName ||
        extractArmorSetPrefix(catItem.item.displayProperties?.name || 'Unknown');
      if (!group.armorSets.has(setName)) {
        group.armorSets.set(setName, []);
      }
      group.armorSets.get(setName)!.push(catItem);
    } else if (catItem.hasLore) {
      group.legendariesWithLore.push(catItem);
    } else {
      group.itemsWithoutLore.push(catItem);
    }
  }

  // Build the tree structure
  definitionTreeRootNode = {
    key: -1,
    type: 'DestinyPresentationNodeDefinition',
    children: new Set(),
    childrenSorted: [],
  };

  const definitionTreeNodeArray: DefinitionTreeNode[] = [];

  // Create "Books" category node (will only be added to root if it has children)
  const booksCategory: DefinitionTreeNode = {
    key: 'books-category' as any,
    type: 'DestinyPresentationNodeDefinition',
    definition: { displayProperties: { name: getTranslation(lang, 'books') } as any } as any,
    children: new Set(),
    childrenSorted: [],
  };
  definitionTreeNodeArray.push(booksCategory);

  // Map: bookHash -> lore entries
  const bookRecordsMap = new Map<
    number,
    Array<{ loreHash: number; record: DestinyRecordDefinition }>
  >();

  // Process all records to find their immediate parent (book)
  const recordKeys = Object.keys(records);
  recordKeys.sort((a, b) => records[Number(a)].index - records[Number(b)].index);

  for (const key of recordKeys) {
    const record = records[Number(key)];
    if (!record.loreHash || !validLoreHashes.has(record.loreHash)) {
      continue;
    }
    // Skip if this lore is already handled as a collectible item
    if (collectibleLoreHashes.has(record.loreHash)) {
      continue;
    }
    const loreEntry = lore[record.loreHash];
    if (!loreEntry) {
      continue;
    }

    // The immediate parent is the book
    const bookHash = record.parentNodeHashes?.[0];
    if (bookHash) {
      if (!bookRecordsMap.has(bookHash)) {
        bookRecordsMap.set(bookHash, []);
      }
      bookRecordsMap.get(bookHash)!.push({ loreHash: record.loreHash, record });
    }
  }

  // Count book entries for logging
  const bookEntryCount = Array.from(bookRecordsMap.values()).reduce(
    (sum, entries) => sum + entries.length,
    0,
  );
  const bookCount = bookRecordsMap.size;

  // Log season stats
  const seasonLabel =
    seasonInfo.season === -1 ? 'Unmapped' : `Season ${seasonInfo.season} (${localizedSeasonName})`;
  console.log(
    `  ${seasonLabel}: ${bookCount} books (${bookEntryCount} entries), ${allSeasonItems.length} items (${itemsWithLore} with lore, ${itemsFlavorOnly} flavor-only)`,
  );

  // Create book nodes
  for (const [bookHash, entries] of bookRecordsMap) {
    const bookPresentationNode = presentationNodes[bookHash];
    if (!bookPresentationNode) continue;

    const bookTreeNode: DefinitionTreeNode = {
      key: bookHash,
      type: 'DestinyPresentationNodeDefinition',
      definition: bookPresentationNode,
      children: new Set(),
      childrenSorted: [],
    };
    definitionTreeNodeArray.push(bookTreeNode);

    // Add all lore entries to this book
    for (const { loreHash } of entries) {
      const loreEntry = lore[loreHash];
      if (!loreEntry) continue;

      // Find inventory item for flavor text
      let inventoryItemNode: DestinyInventoryItemDefinition | undefined;
      for (const item of Object.values(inventoryItems)) {
        if (item.loreHash === loreHash) {
          inventoryItemNode = item;
          break;
        }
      }

      const loreTreeNode: DefinitionTreeNode = {
        key: loreHash,
        type: 'DestinyLoreDefinition',
        definition: loreEntry,
        inventoryItemDefinition: inventoryItemNode,
        children: new Set(),
        childrenSorted: [],
      };
      definitionTreeNodeArray.push(loreTreeNode);
      bookTreeNode.children.add(loreTreeNode);
    }

    sortChildren(bookTreeNode);
    booksCategory.children.add(bookTreeNode);
  }

  sortChildren(booksCategory);

  // Only add Books category to root if it has children
  if (booksCategory.children.size > 0) {
    definitionTreeRootNode.children.add(booksCategory);
  }

  // Create "Items" category node (will only be added to root if it has children)
  const itemsCategory: DefinitionTreeNode = {
    key: 'items-category' as any,
    type: 'DestinyPresentationNodeDefinition',
    definition: { displayProperties: { name: getTranslation(lang, 'items') } as any } as any,
    children: new Set(),
    childrenSorted: [],
  };
  definitionTreeNodeArray.push(itemsCategory);

  // Create source nodes for collectible items (under Items category)
  for (const [sourceKey, group] of sourceGroups) {
    // Skip empty source groups
    const hasContent =
      group.armorSets.size > 0 ||
      group.exotics.length > 0 ||
      group.legendariesWithLore.length > 0 ||
      group.itemsWithoutLore.length > 0;
    if (!hasContent) continue;

    const sourceNode: DefinitionTreeNode = {
      key: sourceKey as any,
      type: 'Source',
      definition: { displayProperties: { name: group.sourceName } as any } as any,
      children: new Set(),
      childrenSorted: [],
      // Store all items for this source directly
      sourceItems: [
        ...Array.from(group.armorSets.values()).flat(),
        ...group.exotics,
        ...group.legendariesWithLore,
        ...group.itemsWithoutLore,
      ],
    };
    definitionTreeNodeArray.push(sourceNode);
    itemsCategory.children.add(sourceNode);

    // Source nodes no longer have children - all items are combined into one chapter
  }

  sortChildren(itemsCategory);

  // Only add Items category to root if it has children
  if (itemsCategory.children.size > 0) {
    definitionTreeRootNode.children.add(itemsCategory);
  }

  sortChildren(definitionTreeRootNode);

  // Debug: Output tree structure if DEBUG_TREE is set
  if (process.env.DEBUG_TREE === 'true') {
    console.log('\n=== TREE STRUCTURE ===');
    const printTree = (node: DefinitionTreeNode, indent = 0) => {
      const prefix = '  '.repeat(indent);
      const name = node.definition?.displayProperties?.name || 'ROOT';
      const type = node.type;
      console.log(`${prefix}- ${name} (${type})`);
      for (const child of node.childrenSorted) {
        printTree(child, indent + 1);
      }
    };
    printTree(definitionTreeRootNode);
    console.log('=== END TREE ===\n');
  }

  const date = new Date();

  const grimoire = getTranslation(lang, 'grimoire');
  const seasonWord = getTranslation(lang, 'season');
  const unmappedContent = getTranslation(lang, 'unmappedContent');
  const releasedWord = getTranslation(lang, 'released');

  const seasonTitle =
    seasonInfo.season === -1
      ? `${grimoire} - ${unmappedContent}`
      : `${grimoire} - ${seasonWord} ${seasonInfo.season}: ${localizedSeasonName}`;

  const seasonDescription =
    seasonInfo.season === -1
      ? unmappedContent
      : `${seasonWord} ${seasonInfo.season}: ${localizedSeasonName}${seasonInfo.DLCName ? ` (${seasonInfo.DLCName})` : ''} - ${releasedWord} ${seasonInfo.releaseDate}`;

  const metadata: nodepub.Metadata = {
    id: seasonInfo.season.toString(),
    cover: './assets/cover.jpg',
    genre: 'Science Fiction',
    title: seasonTitle,
    author: 'Bungie',
    language: lang,
    contents: 'Table of Contents',
    source: 'https://www.bungie.net',
    published: `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`,
    description: seasonDescription,
    images: [],
  };

  await prepImages(metadata, definitionTreeRootNode);

  const epub = nodepub.document(metadata, makeContentsPage);

  epub.addCSS(
    `.presentationNodeIcon { text-align: center; margin-top: 20%; margin-left: 40%; width: 20%; }
     .DestinyPresentationNodeDefinition { text-align: center; }
     h1.DestinyPresentationNodeDefinition { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 90%; margin: 0; }
     .flavor-text { margin: 0.25em 0; font-style: italic; color: #666; }
     .flavor-text p { margin: 0; }
     .item-entry { display: block; margin: 1.5em 0; overflow: hidden; clear: both; }
     .item-entry img { float: left; width: 30%; max-width: 200px; margin-right: 1em; margin-bottom: 0.5em; }
     .item-entry h2 { margin: 0 0 0.25em 0; }
     .item-entry .flavor-text { margin-left: 0; }
     .item-lore { clear: both; }
     .title-page { text-align: center; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 90%; }
     .title-page h1 { font-size: 2em; margin-bottom: 0.5em; }
     .title-page h2 { font-size: 1.2em; font-weight: normal; color: #666; margin-bottom: 1em; }
     .title-page .author { font-size: 1em; margin-top: 2em; }
     .title-page .date { font-size: 0.9em; color: #888; margin-top: 0.5em; }`,
  );

  // Add title page
  const titlePageContent =
    seasonInfo.season === -1
      ? `<div class="title-page">
        <h1>${grimoire}</h1>
        <h2>${unmappedContent}</h2>
        <p class="author">Bungie</p>
      </div>`
      : `<div class="title-page">
        <h1>${grimoire}</h1>
        <h2>${seasonWord} ${seasonInfo.season}: ${localizedSeasonName}</h2>
        ${seasonInfo.DLCName ? `<p>${seasonInfo.DLCName}</p>` : ''}
        <p class="author">Bungie</p>
        <p class="date">${releasedWord} ${seasonInfo.releaseDate}</p>
      </div>`;
  epub.addSection(getTranslation(lang, 'titlePage'), titlePageContent, true, true);

  sortChildren(definitionTreeRootNode);

  for (const child of definitionTreeRootNode.childrenSorted) {
    await addSection(epub, child);
  }

  const filename =
    seasonInfo.season === -1
      ? 'unmapped'
      : `season-${seasonInfo.season.toString().padStart(2, '0')}`;

  await epub.writeEPUB(outputFolder, filename);

  return {
    bookCount,
    bookEntryCount,
    itemCount: allSeasonItems.length,
    itemsWithLore,
    itemsFlavorOnly,
  };
};

// do the thing
(async () => {
  // Load the manifest
  await load();

  const manifestMetadata = await getDestinyManifest($http);
  const current = manifestMetadata.Response.version;
  let newREADME = `# d2-grimoire-epub\ngithub action for generating grimoire epub files when the d2 manifest is updated\n\n Current Manifest: ${current}\n\n# Downloads\n\n`;

  if (!skipCheck) {
    console.log(`Latest:  ${latest}`);
    console.log(`Current: ${current}`);
    if (latest === current) {
      // nothing changed. no updates needed.
      console.log('No manifest update detected');
      return;
    }
    // if you are here, there's a new manifest
    console.log('New manifest detected');
  } else {
    console.log('Skipping manifest check, regenerating EPUBs');
  }

  const contentPaths = manifestMetadata.Response.jsonWorldComponentContentPaths;
  const languages = Object.keys(contentPaths);

  // Allow filtering to specific language for testing
  const testLanguage = process.env.TEST_LANGUAGE;
  const languagesToProcess = testLanguage ? [testLanguage] : languages;

  // Clean up asset folders (skip if testing specific language or KEEP_ASSETS is set)
  if (!testLanguage && !process.env.KEEP_ASSETS) {
    fse.emptyDirSync('./assets/icons');
    fse.emptyDirSync('./assets/screenshotsLarge');
    fse.emptyDirSync('./assets/screenshots');
  }

  // Check for unmapped lore books using English manifest and update the mapping file
  setLanguage('en');
  await load();
  const enPresentationNodes = await fetchDefinition<DestinyPresentationNodeDefinition>(
    contentPaths,
    'en',
    'DestinyPresentationNodeDefinition',
  );
  const enRecords = await fetchDefinition<DestinyRecordDefinition>(
    contentPaths,
    'en',
    'DestinyRecordDefinition',
  );
  const unmappedBooks = findUnmappedLoreBooks(enPresentationNodes, enRecords);
  if (unmappedBooks.size > 0) {
    console.log(
      `\nFound ${unmappedBooks.size} unmapped lore book(s), adding to lore-book-seasons.ts:`,
    );

    // Read current file
    const loreBookSeasonsPath = './src/lore-book-seasons.ts';
    let fileContent = fse.readFileSync(loreBookSeasonsPath, 'utf-8');

    // Find the opening { of the export object
    const openingMatch = fileContent.match(/export const loreBookToSeason[^{]*\{/);
    if (!openingMatch) {
      console.error('Could not find opening of loreBookToSeason in lore-book-seasons.ts');
    } else {
      const openingIndex = openingMatch.index! + openingMatch[0].length;

      // Build new entries
      const newEntries: string[] = [];
      newEntries.push(`\n  // Season ${D2CalculatedSeason}: Auto-discovered`);
      for (const [bookName, season] of unmappedBooks) {
        console.log(`  - "${bookName}" -> Season ${season}`);
        // Escape single quotes in book names
        const escapedName = bookName.includes("'") ? `"${bookName}"` : `'${bookName}'`;
        newEntries.push(`  ${escapedName}: ${season},`);
      }
      newEntries.push(''); // Add blank line after new entries

      // Insert after opening {
      const before = fileContent.slice(0, openingIndex);
      const after = fileContent.slice(openingIndex);
      fileContent = before + newEntries.join('\n') + after;

      fse.writeFileSync(loreBookSeasonsPath, fileContent);
      console.log('Updated lore-book-seasons.ts\n');
    }
  }

  // Generate seasonal EPUBs (one EPUB per season per language)
  console.log('Generating seasonal EPUBs...');

  for (const lang of languagesToProcess) {
    console.log(`\nGenerating seasonal EPUBs for language: ${lang}`);

    // Reload the manifest for this language
    setLanguage(lang as any);
    await load();

    // Set current language for makeContentsPage callback
    currentLanguage = lang;

    // Create language folder
    const langFolder = `./epub/${lang}`;
    fse.ensureDirSync(langFolder);

    // Load necessary tables for season mapping
    const items = await fetchDefinition<DestinyInventoryItemDefinition>(
      contentPaths,
      lang,
      'DestinyInventoryItemDefinition',
    );
    const collectibles = await fetchDefinition<DestinyCollectibleDefinition>(
      contentPaths,
      lang,
      'DestinyCollectibleDefinition',
    );
    const presentationNodes = await fetchDefinition<DestinyPresentationNodeDefinition>(
      contentPaths,
      lang,
      'DestinyPresentationNodeDefinition',
    );
    const records = await fetchDefinition<DestinyRecordDefinition>(
      contentPaths,
      lang,
      'DestinyRecordDefinition',
    );
    const lore = await fetchDefinition<DestinyLoreDefinition>(
      contentPaths,
      lang,
      'DestinyLoreDefinition',
    );
    const seasons = allManifest?.Season || {};

    // Build season mappings
    const loreToSeasonMap = buildLoreToSeasonMap(
      items,
      collectibles,
      presentationNodes,
      records,
      seasons,
    );
    const itemToSeasonMap = buildItemToSeasonMap(items, collectibles, seasons);
    const allLoreHashes = Array.from(loreToSeasonMap.keys());
    const seasonGroups = groupLoreBySeason(allLoreHashes, loreToSeasonMap);
    const allSeasons = getAllSeasons();
    const seasonStatsMap = new Map<number, SeasonStats>();

    // Generate EPUB for each season
    for (const seasonInfo of allSeasons) {
      // Skip if TEST_SEASON is set and doesn't match
      if (process.env.TEST_SEASON && seasonInfo.season.toString() !== process.env.TEST_SEASON) {
        continue;
      }

      const seasonLore = seasonGroups.get(seasonInfo.season) || [];
      if (seasonLore.length === 0) {
        continue;
      }

      definitionTreeRootNode = {
        key: -1,
        type: 'DestinyPresentationNodeDefinition',
        children: new Set(),
        childrenSorted: [],
      };
      contentsIndex = -1;

      const stats = await generateSeasonEpub(
        contentPaths,
        lang,
        seasonInfo,
        seasonLore,
        items,
        collectibles,
        presentationNodes,
        records,
        lore,
        seasons,
        itemToSeasonMap,
        langFolder,
      );
      seasonStatsMap.set(seasonInfo.season, stats);
    }

    // Generate unmapped EPUB
    const unmappedLore = seasonGroups.get(-1) || [];
    let unmappedStats: SeasonStats | undefined;
    if (unmappedLore.length > 0) {
      definitionTreeRootNode = {
        key: -1,
        type: 'DestinyPresentationNodeDefinition',
        children: new Set(),
        childrenSorted: [],
      };
      contentsIndex = -1;

      unmappedStats = await generateSeasonEpub(
        contentPaths,
        lang,
        { season: -1, seasonName: 'Unmapped', seasonTag: '', releaseDate: '', DLCName: '' },
        unmappedLore,
        items,
        collectibles,
        presentationNodes,
        records,
        lore,
        seasons,
        itemToSeasonMap,
        langFolder,
      );
    }

    // Update README with season links
    newREADME += `\n## ${lang.toUpperCase()}\n`;
    for (const seasonInfo of allSeasons) {
      const stats = seasonStatsMap.get(seasonInfo.season);
      if (stats) {
        const filename = `season-${seasonInfo.season.toString().padStart(2, '0')}.epub`;
        newREADME += `- [Season ${seasonInfo.season}: ${seasonInfo.seasonName}](https://github.com/chrisfried/d2-grimoire-epub/raw/master/epub/${lang}/${filename}) (${stats.bookCount} books, ${stats.itemCount} items)\n`;
      }
    }
    if (unmappedStats) {
      newREADME += `- [Unmapped Content](https://github.com/chrisfried/d2-grimoire-epub/raw/master/epub/${lang}/unmapped.epub) (${unmappedStats.bookCount} books, ${unmappedStats.itemCount} items)\n`;
    }
  }

  writeFileSync('latest.json', `${JSON.stringify(current, null, 2)}\n`, 'utf8');
  writeFileSync('README.md', newREADME, 'utf8');

  console.log('EPUB generation complete!');
})().catch((e) => {
  console.error('Error generating EPUBs:', e);
  process.exit(1);
});

interface DefinitionTreeNode {
  key: number | string;
  type: 'DestinyLoreDefinition' | 'DestinyPresentationNodeDefinition' | 'Source' | 'BatchedItems';
  definition?: DestinyLoreDefinition | DestinyPresentationNodeDefinition;
  inventoryItemDefinition?: DestinyInventoryItemDefinition;
  collectibleDefinition?: DestinyCollectibleDefinition;
  batchedItems?: CategorizedItem[];
  batchType?: 'armor-set' | 'exotics' | 'legendaries-with-lore' | 'items-without-lore';
  sourceItems?: CategorizedItem[]; // All items for a Source node
  children: Set<DefinitionTreeNode>;
  childrenSorted: DefinitionTreeNode[];
}
