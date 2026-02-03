import { D2SeasonInfo, D2CalculatedSeason } from '../d2ai-module/d2-season-info.js';
import watermarkToSeason from '../d2ai-module/watermark-to-season.json' with { type: 'json' };
import sourceToSeason from '../d2ai-module/source-to-season-v2.json' with { type: 'json' };
import itemHashToSeason from '../d2ai-module/seasons.json' with { type: 'json' };
import { loreBookToSeason } from './lore-book-seasons.js';
import {
  DestinyInventoryItemDefinition,
  DestinyPresentationNodeDefinition,
  DestinyCollectibleDefinition,
  DestinyRecordDefinition,
} from 'bungie-api-ts/destiny2';

export interface SeasonInfo {
  season: number;
  seasonName: string;
  seasonTag: string;
  releaseDate: string;
  DLCName: string;
}

/**
 * Manual mapping for subclass lore entries
 * - Base Arc/Solar/Void classes: Season 1 (base game)
 * - Stasis classes: Season 12 (Beyond Light)
 * - Strand classes: Season 20 (Lightfall)
 * - Prismatic classes: Season 28 (The Final Shape)
 */
export const subclassToSeason: Record<string, number> = {
  // Base game - Season 1
  Nightstalker: 1, // Void Hunter
  Striker: 1, // Arc Titan
  Dawnblade: 1, // Solar Warlock
  Voidwalker: 1, // Void Warlock
  Arcstrider: 1, // Arc Hunter
  Stormcaller: 1, // Arc Warlock
  Sentinel: 1, // Void Titan
  Sunbreaker: 1, // Solar Titan
  Gunslinger: 1, // Solar Hunter
  // Stasis - Season 12 (Beyond Light)
  Behemoth: 12, // Stasis Titan
  Revenant: 12, // Stasis Hunter
  Shadebinder: 12, // Stasis Warlock
  // Strand - Season 20 (Lightfall)
  Berserker: 20, // Strand Titan
  Threadrunner: 20, // Strand Hunter
  Broodweaver: 20, // Strand Warlock
  // Prismatic - Season 28 (The Final Shape)
  'Prismatic Hunter': 28,
  'Prismatic Titan': 28,
  'Prismatic Warlock': 28,
};

/**
 * Maps watermark icon paths to season numbers
 */
export const watermarkSeasonMap: Record<string, number> = watermarkToSeason;

/**
 * Get season information by season number
 */
export function getSeasonInfo(seasonNumber: number): SeasonInfo | undefined {
  const info = D2SeasonInfo[seasonNumber];
  if (!info) return undefined;

  return {
    season: info.season,
    seasonName: info.seasonName,
    seasonTag: info.seasonTag,
    releaseDate: info.releaseDate,
    DLCName: info.DLCName,
  };
}

/**
 * Get all seasons in chronological order
 */
export function getAllSeasons(): SeasonInfo[] {
  return Object.values(D2SeasonInfo)
    .sort((a, b) => a.season - b.season)
    .map((info) => ({
      season: info.season,
      seasonName: info.seasonName,
      seasonTag: info.seasonTag,
      releaseDate: info.releaseDate,
      DLCName: info.DLCName,
    }));
}

/**
 * Build a set of all presentation node hashes that are descendants of the Lore collection.
 * This is used to verify that a lore book is actually part of the in-game Lore collection
 * rather than being an orphaned or test entry.
 */
function buildLoreDescendantsSet(presentationNodes: {
  [hash: number]: DestinyPresentationNodeDefinition;
}): Set<number> {
  const loreDescendants = new Set<number>();

  // Find the root Lore collection node (hash: 1993337477)
  // This is the top-level "Lore" collection that contains all lore books
  const loreCollectionHash = 1993337477;
  const loreCollection = presentationNodes[loreCollectionHash];

  if (!loreCollection) {
    console.warn('Could not find Lore collection presentation node');
    return loreDescendants;
  }

  // BFS to find all descendants
  const queue = [loreCollectionHash];

  while (queue.length > 0) {
    const currentHash = queue.shift()!;
    loreDescendants.add(currentHash);

    const node = presentationNodes[currentHash];
    if (node?.children?.presentationNodes) {
      for (const child of node.children.presentationNodes) {
        queue.push(child.presentationNodeHash);
      }
    }
  }

  return loreDescendants;
}

/**
 * Map an inventory item to a season via its iconWatermark
 */
export function getItemSeason(item: DestinyInventoryItemDefinition): number | undefined {
  if (!item.iconWatermark) return undefined;
  return watermarkSeasonMap[item.iconWatermark];
}

/**
 * Build a comprehensive mapping of lore to seasons
 * Uses multiple strategies (in order of priority):
 * 0. Manual subclass mapping (by name)
 * 1. Item seasonHash (most direct - authoritative season assignment)
 * 2. Item watermark (iconWatermark field)
 * 3. Collectible sourceHash
 * 3b. Direct item hash lookup (DIM's final fallback - catches event gear)
 * 4. Record -> Lore book (presentation nodes) -> Manual book mapping
 */
export function buildLoreToSeasonMap(
  items: { [hash: number]: DestinyInventoryItemDefinition },
  collectibles: { [hash: number]: DestinyCollectibleDefinition },
  presentationNodes: { [hash: number]: DestinyPresentationNodeDefinition },
  records: { [hash: number]: DestinyRecordDefinition },
  seasons: { [hash: number]: any },
): Map<number, number> {
  const loreToSeason = new Map<number, number>();

  // Build seasonHash -> season number mapping
  const seasonHashToNumber: Record<number, number> = {};
  for (const [hash, season] of Object.entries(seasons)) {
    if (season.seasonNumber !== undefined) {
      seasonHashToNumber[parseInt(hash)] = season.seasonNumber;
    }
  }

  // Strategy 0: Manual subclass mapping
  for (const item of Object.values(items)) {
    if (item.loreHash) {
      const itemName = item.displayProperties?.name;
      if (itemName && subclassToSeason[itemName]) {
        loreToSeason.set(item.loreHash, subclassToSeason[itemName]);
      }
    }
  }

  // Strategy 1: Items with lore and seasonHash (MOST DIRECT - check first!)
  for (const item of Object.values(items)) {
    if (item.loreHash && !loreToSeason.has(item.loreHash) && item.seasonHash) {
      const season = seasonHashToNumber[item.seasonHash];
      if (season) {
        loreToSeason.set(item.loreHash, season);
      }
    }
  }

  // Strategy 2: Items with lore and watermarks (weapon/armor flavor text)
  for (const item of Object.values(items)) {
    if (item.loreHash && item.iconWatermark && !loreToSeason.has(item.loreHash)) {
      const season = watermarkSeasonMap[item.iconWatermark];
      if (season) {
        loreToSeason.set(item.loreHash, season);
      }
    }
  }

  // Strategy 3: Items with lore -> collectible sourceHash
  for (const item of Object.values(items)) {
    if (item.loreHash && !loreToSeason.has(item.loreHash) && item.collectibleHash) {
      const collectible = collectibles[item.collectibleHash];
      if (collectible?.sourceHash) {
        const season =
          sourceToSeason[collectible.sourceHash.toString() as keyof typeof sourceToSeason];
        if (season) {
          loreToSeason.set(item.loreHash, season);
        }
      }
    }
  }

  // Strategy 3b: Direct item hash lookup (DIM's Tier 3 fallback)
  // This catches event gear and other items not covered by watermark/source strategies
  for (const item of Object.values(items)) {
    if (item.loreHash && !loreToSeason.has(item.loreHash)) {
      const season = itemHashToSeason[item.hash.toString() as keyof typeof itemHashToSeason];
      if (season) {
        loreToSeason.set(item.loreHash, season);
      }
    }
  }

  // Strategy 4: Records with lore -> Lore books (presentation nodes) -> Manual book mapping
  // First, build a set of all presentation nodes that are descendants of the Lore collection
  // This ensures we only map lore that's actually part of the in-game Lore collection
  const loreDescendants = buildLoreDescendantsSet(presentationNodes);

  // Build reverse lookup: loreHash -> record
  const loreHashToRecords = new Map<number, DestinyRecordDefinition[]>();
  for (const record of Object.values(records)) {
    if (record.loreHash) {
      if (!loreHashToRecords.has(record.loreHash)) {
        loreHashToRecords.set(record.loreHash, []);
      }
      loreHashToRecords.get(record.loreHash)!.push(record);
    }
  }

  // For each unmapped lore, try to find its season through its record's parent node (lore book)
  for (const [loreHash, recordsForLore] of loreHashToRecords.entries()) {
    if (loreToSeason.has(loreHash)) continue; // Already mapped

    for (const record of recordsForLore) {
      if (record.parentNodeHashes && record.parentNodeHashes.length > 0) {
        // Check if the parent node (lore book) has a manual season mapping
        for (const parentNodeHash of record.parentNodeHashes) {
          const parentNode = presentationNodes[parentNodeHash];
          if (!parentNode) continue;

          // Only apply manual mapping if this node is a descendant of the Lore collection
          if (!loreDescendants.has(parentNodeHash)) continue;

          const bookName = parentNode.displayProperties?.name;
          if (bookName && loreBookToSeason[bookName]) {
            loreToSeason.set(loreHash, loreBookToSeason[bookName]);
            break;
          }
        }
        if (loreToSeason.has(loreHash)) break; // Found a season, stop looking
      }
    }
  }

  // Strategy 5: Collectibles -> Items with watermarks (shouldn't be needed if Strategy 2 works, but keep as fallback)
  for (const collectible of Object.values(collectibles)) {
    if (collectible.itemHash) {
      const item = items[collectible.itemHash];
      if (item?.loreHash && item.iconWatermark) {
        const season = watermarkSeasonMap[item.iconWatermark];
        if (season && !loreToSeason.has(item.loreHash)) {
          loreToSeason.set(item.loreHash, season);
        }
      }
    }
  }

  // Strategy 4: Presentation nodes that mention seasons
  const seasonalNodePatterns = /season\s+(\d+)|season\s+of\s+the\s+(\w+)|episode:\s*(\w+)/i;

  for (const node of Object.values(presentationNodes)) {
    const nodeName = node.displayProperties?.name || '';
    const match = nodeName.match(seasonalNodePatterns);

    if (match && node.children?.collectibles) {
      // Try to infer season from collectibles in this node
      const collectibleHashes = node.children.collectibles.map((c) => c.collectibleHash);
      const seasonCounts = new Map<number, number>();

      for (const collectibleHash of collectibleHashes) {
        const collectible = collectibles[collectibleHash];
        if (collectible?.itemHash) {
          const item = items[collectible.itemHash];
          if (item?.iconWatermark) {
            const season = watermarkSeasonMap[item.iconWatermark];
            if (season) {
              seasonCounts.set(season, (seasonCounts.get(season) || 0) + 1);
            }
          }
        }
      }

      // Find the most common season in this node
      if (seasonCounts.size > 0) {
        const mostCommonSeason = Array.from(seasonCounts.entries()).sort(
          (a, b) => b[1] - a[1],
        )[0][0];

        // Apply this season to all lore in collectibles under this node
        for (const collectibleHash of collectibleHashes) {
          const collectible = collectibles[collectibleHash];
          if (collectible?.itemHash) {
            const item = items[collectible.itemHash];
            if (item?.loreHash && !loreToSeason.has(item.loreHash)) {
              loreToSeason.set(item.loreHash, mostCommonSeason);
            }
          }
        }
      }
    }
  }

  return loreToSeason;
}

/**
 * Build a mapping of inventory item hashes to seasons
 * This is used to filter items by season, especially for flavor-text-only items
 * that don't have lore.
 */
export function buildItemToSeasonMap(
  items: { [hash: number]: DestinyInventoryItemDefinition },
  collectibles: { [hash: number]: DestinyCollectibleDefinition },
  seasons: { [hash: number]: any },
): Map<number, number> {
  const itemToSeason = new Map<number, number>();

  // Build seasonHash -> season number mapping
  const seasonHashToNumber: Record<number, number> = {};
  for (const [hash, season] of Object.entries(seasons)) {
    if (season.seasonNumber !== undefined) {
      seasonHashToNumber[parseInt(hash)] = season.seasonNumber;
    }
  }

  // Strategy 1: Items with seasonHash (most authoritative)
  for (const item of Object.values(items)) {
    if (item.hash && item.seasonHash && !itemToSeason.has(item.hash)) {
      const season = seasonHashToNumber[item.seasonHash];
      if (season) {
        itemToSeason.set(item.hash, season);
      }
    }
  }

  // Strategy 2: Items with watermarks
  for (const item of Object.values(items)) {
    if (item.hash && item.iconWatermark && !itemToSeason.has(item.hash)) {
      const season = watermarkSeasonMap[item.iconWatermark];
      if (season) {
        itemToSeason.set(item.hash, season);
      }
    }
  }

  // Strategy 3: Collectible sourceHash
  for (const item of Object.values(items)) {
    if (item.hash && !itemToSeason.has(item.hash) && item.collectibleHash) {
      const collectible = collectibles[item.collectibleHash];
      if (collectible?.sourceHash) {
        const season =
          sourceToSeason[collectible.sourceHash.toString() as keyof typeof sourceToSeason];
        if (season) {
          itemToSeason.set(item.hash, season);
        }
      }
    }
  }

  // Strategy 4: Direct item hash lookup
  for (const item of Object.values(items)) {
    if (item.hash && !itemToSeason.has(item.hash)) {
      const season = itemHashToSeason[item.hash.toString() as keyof typeof itemHashToSeason];
      if (season) {
        itemToSeason.set(item.hash, season);
      }
    }
  }

  return itemToSeason;
}

/**
 * Group lore entries by season
 */
export function groupLoreBySeason(
  loreHashes: number[],
  loreToSeasonMap: Map<number, number>,
): Map<number, number[]> {
  const seasonToLore = new Map<number, number[]>();

  for (const loreHash of loreHashes) {
    const season = loreToSeasonMap.get(loreHash);
    if (season) {
      if (!seasonToLore.has(season)) {
        seasonToLore.set(season, []);
      }
      seasonToLore.get(season)!.push(loreHash);
    }
  }

  return seasonToLore;
}

/**
 * Find lore books that are in the Lore collection but not in our manual mapping.
 * Returns a map of book name -> season number (using current season for new books).
 */
export function findUnmappedLoreBooks(
  presentationNodes: { [hash: number]: DestinyPresentationNodeDefinition },
  records: { [hash: number]: DestinyRecordDefinition },
): Map<string, number> {
  const unmappedBooks = new Map<string, number>();

  // Build the set of lore collection descendants
  const loreDescendants = buildLoreDescendantsSet(presentationNodes);

  // Find all unique book names that have records with lore but aren't in the manual mapping
  const bookNames = new Set<string>();

  for (const record of Object.values(records)) {
    if (!record.loreHash) continue;
    if (!record.parentNodeHashes || record.parentNodeHashes.length === 0) continue;

    for (const parentNodeHash of record.parentNodeHashes) {
      if (!loreDescendants.has(parentNodeHash)) continue;

      const parentNode = presentationNodes[parentNodeHash];
      const bookName = parentNode?.displayProperties?.name;
      if (bookName && !loreBookToSeason[bookName]) {
        bookNames.add(bookName);
      }
    }
  }

  // Assign current season to new books
  for (const bookName of bookNames) {
    unmappedBooks.set(bookName, D2CalculatedSeason);
  }

  return unmappedBooks;
}

/** Re-export D2CalculatedSeason for use in main script */
export { D2CalculatedSeason };
