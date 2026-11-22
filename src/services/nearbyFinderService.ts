import { db } from '../db/index.ts';
import type {
  NearbyOtherResourceMatch,
  NearbyResourceShop,
  UserGeoLocation,
} from '../types/resource.ts';

export function haversineDistanceKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

interface NominatimPlace {
  place_id?: number;
  osm_type?: string;
  osm_id?: number;
  lat?: string;
  lon?: string;
  name?: string;
  display_name?: string;
  category?: string;
  type?: string;
  address?: {
    road?: string;
    suburb?: string;
    neighbourhood?: string;
    city?: string;
    town?: string;
    state?: string;
    country?: string;
    postcode?: string;
  };
  extratags?: {
    opening_hours?: string;
    phone?: string;
    'contact:phone'?: string;
    website?: string;
    'contact:website'?: string;
    access?: string;
  };
}

const SHOP_CACHE_TTL_MS = 15 * 60 * 1000;
const shopCache = new Map<string, { items: NearbyResourceShop[]; expiresAt: number }>();

function buildShopQueriesForResource(resourceName: string, category?: string): string[] {
  const n = resourceName.toLowerCase();
  const c = (category || '').toLowerCase();

  if (
    /\b(gold|silver|platinum|diamond|ruby|emerald|sapphire|gem|opal|amethyst|turquoise|jade)\b/.test(
      n
    ) ||
    c.includes('gemstone')
  ) {
    return ['[jewelry]', `${resourceName} jewellers`, 'gold jewellers'];
  }

  if (
    /\b(granite|marble|limestone|sandstone|basalt|slate|quartzite|gypsum|travertine)\b/.test(n) ||
    c.includes('rock')
  ) {
    return [`${resourceName} tiles`, 'marble granite', '[hardware]'];
  }

  if (
    /\b(soil|loam|peat|clay|silt|compost|laterite|alluvial|black soil|red soil)\b/.test(n) ||
    c.includes('soil') ||
    /\b(bamboo|timber|teak|sandalwood|medicinal|forest|wood|oak|pine)\b/.test(n) ||
    c.includes('forest')
  ) {
    return ['[garden_centre]', 'plant nursery', '[hardware]'];
  }

  if (
    /\b(water|river|lake|aquifer|groundwater|spring)\b/.test(n) ||
    c.includes('water')
  ) {
    return ['[drinking_water]', 'water supply', '[water_point]'];
  }

  if (
    /\b(coal|petroleum|oil|natural gas|lpg|methane|fuel)\b/.test(n) ||
    c.includes('energy')
  ) {
    return ['[fuel]', 'gas agency', '[hardware]'];
  }

  if (
    /\b(copper|iron|lithium|aluminum|aluminium|zinc|nickel|cobalt|tungsten|titanium|silicon|quartz|salt|halite)\b/.test(
      n
    ) ||
    c.includes('metal') ||
    c.includes('mineral') ||
    c.includes('chemical')
  ) {
    return ['[hardware]', 'electrical metal supply', 'building materials'];
  }

  return ['[hardware]', '[garden_centre]', 'general store'];
}

function formatShopTypeLabel(category?: string, type?: string, resourceName?: string): string {
  const t = (type || '').replace(/_/g, ' ').trim();
  const c = (category || '').replace(/_/g, ' ').trim();
  if (t && t !== 'yes') {
    return t.replace(/\b\w/g, (m) => m.toUpperCase());
  }
  if (c) {
    return c.replace(/\b\w/g, (m) => m.toUpperCase());
  }
  return `${resourceName || 'Resource'} Supplier`;
}

function formatAvailability(place: NominatimPlace): string {
  const hours = place.extratags?.opening_hours;
  const access = place.extratags?.access;
  if (hours) {
    if (hours.trim() === '24/7') {
      return 'Open 24/7 · Public access';
    }
    return `Available (${hours})`;
  }
  if (place.category === 'amenity' && (place.type === 'drinking_water' || place.type === 'fuel')) {
    return access === 'private'
      ? 'Restricted / private access'
      : 'Public station · Daily customer availability';
  }
  return 'Local supplier · Check counter hours for stock';
}

function buildCompactAddress(place: NominatimPlace): string {
  const addr = place.address;
  if (addr) {
    const parts = [
      addr.road,
      addr.suburb || addr.neighbourhood,
      addr.city || addr.town || addr.state,
      addr.country,
    ].filter(Boolean);
    if (parts.length > 0) return parts.join(', ');
  }
  return place.display_name || 'Local Area';
}

const EXCLUDED_CATEGORIES = new Set([
  'leisure',
  'sport',
  'education',
  'healthcare',
  'tourism',
  'historic',
  'railway',
  'highway',
  'boundary',
]);

export async function findNearbyShopsForResource(
  resourceName: string,
  category: string | undefined,
  userLocation: UserGeoLocation,
  limit = 10
): Promise<NearbyResourceShop[]> {
  if (!Number.isFinite(userLocation.latitude) || !Number.isFinite(userLocation.longitude)) {
    return [];
  }

  const cacheKey = `${resourceName.toLowerCase()}::${userLocation.latitude.toFixed(
    2
  )},${userLocation.longitude.toFixed(2)}`;
  const cached = shopCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.items.slice(0, limit);
  }

  const queries = buildShopQueriesForResource(resourceName, category);
  // ~35 km bounding box around user coordinates
  const delta = 0.35;
  const viewbox = `${(userLocation.longitude - delta).toFixed(4)},${(
    userLocation.latitude + delta
  ).toFixed(4)},${(userLocation.longitude + delta).toFixed(4)},${(
    userLocation.latitude - delta
  ).toFixed(4)}`;

  const fetchedLists = await Promise.all(
    queries.map(async (q) => {
      try {
        const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(
          q
        )}&format=jsonv2&addressdetails=1&extratags=1&limit=10&bounded=1&viewbox=${viewbox}`;
        const res = await fetch(url, {
          headers: {
            Accept: 'application/json',
            'User-Agent': 'GlobalNaturalResourcesExplorer/1.0',
          },
          signal: AbortSignal.timeout(5500),
        });
        if (!res.ok) return [] as NominatimPlace[];
        const json = (await res.json()) as NominatimPlace[];
        return Array.isArray(json) ? json : [];
      } catch {
        return [] as NominatimPlace[];
      }
    })
  );

  const dedup = new Map<string, NearbyResourceShop>();

  for (const list of fetchedLists) {
    for (const p of list) {
      if (p.category && EXCLUDED_CATEGORIES.has(p.category)) continue;
      const lat = Number.parseFloat(p.lat || '');
      const lon = Number.parseFloat(p.lon || '');
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      const rawName = (p.name || '').trim();
      const fallbackTitle = p.display_name?.split(',')[0]?.trim() || '';
      const shopName =
        rawName ||
        (fallbackTitle && fallbackTitle.length > 2
          ? fallbackTitle
          : formatShopTypeLabel(p.category, p.type, resourceName));

      if (!shopName) continue;
      const coordKey = `${shopName.toLowerCase()}::${lat.toFixed(3)},${lon.toFixed(3)}`;
      if (dedup.has(coordKey)) continue;

      const distanceKm = haversineDistanceKm(
        userLocation.latitude,
        userLocation.longitude,
        lat,
        lon
      );

      dedup.set(coordKey, {
        id: String(p.place_id || `${lat.toFixed(4)}-${lon.toFixed(4)}`),
        name: shopName,
        shopType: formatShopTypeLabel(p.category, p.type, resourceName),
        address: buildCompactAddress(p),
        latitude: lat,
        longitude: lon,
        distanceKm,
        availability: formatAvailability(p),
        phone: p.extratags?.phone || p.extratags?.['contact:phone'] || null,
        website: p.extratags?.website || p.extratags?.['contact:website'] || null,
        sourceName: 'OpenStreetMap Directory',
      });
    }
  }

  const sorted = Array.from(dedup.values())
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, Math.max(limit, 12));

  if (shopCache.size >= 150) {
    const firstKey = shopCache.keys().next().value;
    if (firstKey) shopCache.delete(firstKey);
  }
  shopCache.set(cacheKey, {
    items: sorted,
    expiresAt: Date.now() + SHOP_CACHE_TTL_MS,
  });

  return sorted.slice(0, limit);
}

export async function findNearbyCatalogResources(
  userLocation: UserGeoLocation,
  excludeSlug?: string,
  limit = 10
): Promise<NearbyOtherResourceMatch[]> {
  if (!Number.isFinite(userLocation.latitude) || !Number.isFinite(userLocation.longitude)) {
    return [];
  }

  try {
    const allResources = await db.query.resources.findMany({
      with: { occurrences: true },
    });

    const bestPerResource = new Map<string, NearbyOtherResourceMatch>();
    const excludeLower = (excludeSlug || '').toLowerCase();

    for (const resItem of allResources) {
      if (excludeLower && resItem.slug.toLowerCase() === excludeLower) continue;

      for (const occ of resItem.occurrences || []) {
        if (!Number.isFinite(occ.latitude) || !Number.isFinite(occ.longitude)) continue;
        const dist = haversineDistanceKm(
          userLocation.latitude,
          userLocation.longitude,
          occ.latitude,
          occ.longitude
        );
        const existing = bestPerResource.get(resItem.slug);
        if (!existing || dist < existing.distanceKm) {
          bestPerResource.set(resItem.slug, {
            slug: resItem.slug,
            name: resItem.name,
            category: resItem.category,
            siteName: occ.siteName,
            country: occ.country,
            latitude: occ.latitude,
            longitude: occ.longitude,
            distanceKm: dist,
            depositType: occ.depositType,
          });
        }
      }
    }

    return Array.from(bestPerResource.values())
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, limit);
  } catch {
    return [];
  }
}
