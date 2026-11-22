import React, { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  Clock,
  Compass,
  Crosshair,
  ExternalLink,
  Layers,
  Loader2,
  MapPin,
  Phone,
  Search,
  Store,
  X,
} from 'lucide-react';
import type {
  NearbyOtherResourceMatch,
  NearbyResourceShop,
  ResourceOccurrence,
  UserGeoLocation,
} from '../types/resource';

interface NearbyUserResourceMapProps {
  resourceSlug: string;
  resourceName: string;
  resourceCategory?: string;
  userLocation: UserGeoLocation | null;
  nearestOccurrences: ResourceOccurrence[];
  nearbyShops: NearbyResourceShop[];
  nearbyOtherResources: NearbyOtherResourceMatch[];
  onUpdateNearbyData: (payload: {
    userLocation: UserGeoLocation | null;
    nearestOccurrences: ResourceOccurrence[];
    nearbyShops: NearbyResourceShop[];
    nearbyOtherResources: NearbyOtherResourceMatch[];
  }) => void;
  onOpenResourceSlug?: (slug: string) => void;
  heightClass?: string;
}

const USER_LOCATION_STORAGE_KEY = 'gnre_user_location_v1';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function createPinIcon(fill: string, ring: string, size = 18): L.DivIcon {
  const half = Math.round(size / 2);
  return L.divIcon({
    className: 'custom-nearby-pin',
    html: `<span style="display:block;width:${size}px;height:${size}px;border-radius:9999px;background:${fill};border:3px solid ${ring};box-shadow:0 2px 6px rgba(15,23,42,0.4);"></span>`,
    iconSize: [size, size],
    iconAnchor: [half, half],
    popupAnchor: [0, -half],
  });
}

export const NearbyUserResourceMap: React.FC<NearbyUserResourceMapProps> = ({
  resourceSlug,
  resourceName,
  resourceCategory,
  userLocation,
  nearestOccurrences,
  nearbyShops,
  nearbyOtherResources,
  onUpdateNearbyData,
  onOpenResourceSlug,
  heightClass = 'h-[430px]',
}) => {
  const mapElRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerGroupRef = useRef<L.LayerGroup | null>(null);
  const markerLookupRef = useRef<Map<string, L.Marker>>(new Map());

  const [cityQuery, setCityQuery] = useState('');
  const [loadingNearby, setLoadingNearby] = useState(false);
  const [locError, setLocError] = useState<string | null>(null);

  const [showAskedSites, setShowAskedSites] = useState(true);
  const [showShops, setShowShops] = useState(true);
  const [showOtherResources, setShowOtherResources] = useState(true);

  const validOccurrences = useMemo(
    () =>
      nearestOccurrences.filter(
        (o) => Number.isFinite(o.latitude) && Number.isFinite(o.longitude)
      ),
    [nearestOccurrences]
  );

  const validShops = useMemo(
    () =>
      nearbyShops.filter(
        (s) => Number.isFinite(s.latitude) && Number.isFinite(s.longitude)
      ),
    [nearbyShops]
  );

  const validOtherResources = useMemo(
    () =>
      nearbyOtherResources.filter(
        (r) => Number.isFinite(r.latitude) && Number.isFinite(r.longitude)
      ),
    [nearbyOtherResources]
  );

  const persistUserLoc = (loc: UserGeoLocation | null) => {
    try {
      if (loc) {
        window.sessionStorage.setItem(USER_LOCATION_STORAGE_KEY, JSON.stringify(loc));
      } else {
        window.sessionStorage.removeItem(USER_LOCATION_STORAGE_KEY);
      }
    } catch {
      // Ignore storage access errors
    }
  };

  const fetchNearbyBundle = async (loc: UserGeoLocation) => {
    setLoadingNearby(true);
    setLocError(null);
    try {
      const params = new URLSearchParams({
        slug: resourceSlug,
        name: resourceName,
        lat: String(loc.latitude),
        lon: String(loc.longitude),
        label: loc.label || `${loc.latitude.toFixed(2)}°, ${loc.longitude.toFixed(2)}°`,
      });
      if (resourceCategory) {
        params.set('category', resourceCategory);
      }

      const res = await fetch(`/api/resources/nearby?${params.toString()}`);
      const text = await res.text();
      const json = text
        ? (JSON.parse(text) as {
            userLocation?: UserGeoLocation;
            nearestOccurrences?: ResourceOccurrence[];
            nearbyShops?: NearbyResourceShop[];
            nearbyOtherResources?: NearbyOtherResourceMatch[];
            error?: string;
          })
        : null;

      if (!res.ok || !json) {
        throw new Error(json?.error || `Failed to load nearby availability (HTTP ${res.status}).`);
      }

      const resolvedLoc = json.userLocation || loc;
      persistUserLoc(resolvedLoc);
      onUpdateNearbyData({
        userLocation: resolvedLoc,
        nearestOccurrences: json.nearestOccurrences || [],
        nearbyShops: json.nearbyShops || [],
        nearbyOtherResources: json.nearbyOtherResources || [],
      });
    } catch (err: unknown) {
      setLocError(
        err instanceof Error ? err.message : 'Unable to retrieve nearby availability.'
      );
    } finally {
      setLoadingNearby(false);
    }
  };

  const handleUseGps = () => {
    setLocError(null);
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setLocError('Browser GPS is unavailable here. Enter your city, town, or country instead.');
      return;
    }
    setLoadingNearby(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const loc: UserGeoLocation = {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          label: `Your GPS (${pos.coords.latitude.toFixed(2)}°, ${pos.coords.longitude.toFixed(2)}°)`,
        };
        void fetchNearbyBundle(loc);
      },
      () => {
        setLoadingNearby(false);
        setLocError(
          'Browser GPS permission was declined. Enter your city or town below to view nearby resources and shops.'
        );
      },
      { enableHighAccuracy: false, timeout: 4500, maximumAge: 300000 }
    );
  };

  const handleCitySearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = cityQuery.trim();
    if (q.length < 2) return;
    setLoadingNearby(true);
    setLocError(null);
    try {
      const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
      const text = await res.text();
      const data = text
        ? (JSON.parse(text) as { results?: UserGeoLocation[]; error?: string })
        : null;
      if (!res.ok || !data?.results?.length) {
        throw new Error(
          data?.error || `No matching coordinates found for "${q}". Try a nearby major city.`
        );
      }
      const best = data.results[0];
      setCityQuery('');
      await fetchNearbyBundle(best);
    } catch (err: unknown) {
      setLocError(err instanceof Error ? err.message : 'Could not geocode location.');
      setLoadingNearby(false);
    }
  };

  // Initialize Leaflet Map instance once
  useEffect(() => {
    const el = mapElRef.current;
    if (!el || mapRef.current) return;

    const map = L.map(el, {
      center: [20, 15],
      zoom: 2,
      minZoom: 2,
      maxZoom: 18,
      scrollWheelZoom: false,
      worldCopyJump: true,
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 18,
    }).addTo(map);

    const group = L.layerGroup().addTo(map);
    mapRef.current = map;
    layerGroupRef.current = group;

    const timerId = window.setTimeout(() => {
      map.invalidateSize();
    }, 60);

    return () => {
      window.clearTimeout(timerId);
      markerLookupRef.current.clear();
      map.remove();
      mapRef.current = null;
      layerGroupRef.current = null;
    };
  }, []);

  // Re-plot markers & fit bounds whenever nearby data or visibility toggles change
  useEffect(() => {
    const map = mapRef.current;
    const group = layerGroupRef.current;
    if (!map || !group) return;

    group.clearLayers();
    markerLookupRef.current.clear();

    const boundsPoints: L.LatLngExpression[] = [];

    const hasUser =
      Boolean(userLocation) &&
      Number.isFinite(userLocation?.latitude) &&
      Number.isFinite(userLocation?.longitude);

    if (hasUser && userLocation) {
      const userLatLng: L.LatLngExpression = [userLocation.latitude, userLocation.longitude];
      boundsPoints.push(userLatLng);

      const userMarker = L.marker(userLatLng, {
        icon: createPinIcon('#2563eb', '#ffffff', 20),
        zIndexOffset: 500,
      }).bindPopup(
        `<div style="min-width:190px;font-family:system-ui,sans-serif;">
          <div style="font-size:11px;font-weight:700;color:#1d4ed8;text-transform:uppercase;">Your Location</div>
          <div style="font-size:13px;font-weight:700;color:#0f172a;margin-top:2px;">${escapeHtml(
            userLocation.label || 'Selected Location'
          )}</div>
          <div style="font-size:11px;color:#475569;margin-top:4px;font-family:monospace;">${userLocation.latitude.toFixed(
            4
          )}°, ${userLocation.longitude.toFixed(4)}°</div>
        </div>`
      );
      userMarker.addTo(group);
      markerLookupRef.current.set('user', userMarker);
    }

    if (showAskedSites) {
      validOccurrences.forEach((occ, idx) => {
        const pt: L.LatLngExpression = [occ.latitude, occ.longitude];
        boundsPoints.push(pt);

        if (hasUser && userLocation) {
          L.polyline(
            [
              [userLocation.latitude, userLocation.longitude],
              [occ.latitude, occ.longitude],
            ],
            {
              color: '#0f766e',
              weight: 1.75,
              opacity: 0.55,
              dashArray: '5,5',
            }
          ).addTo(group);
        }

        const marker = L.marker(pt, {
          icon: createPinIcon('#0f766e', '#ffffff', 16),
          zIndexOffset: 300,
        }).bindPopup(
          `<div style="min-width:210px;font-family:system-ui,sans-serif;">
            <div style="font-size:11px;font-weight:700;color:#0f766e;">${escapeHtml(
              resourceName
            )} Site${typeof occ.distanceKm === 'number' ? ` · ~${occ.distanceKm} km` : ''}</div>
            <div style="font-size:13px;font-weight:700;color:#0f172a;margin-top:2px;">${escapeHtml(
              occ.siteName
            )}</div>
            <div style="font-size:11px;color:#475569;margin-top:3px;">${escapeHtml(
              occ.country
            )} · ${escapeHtml(occ.region)}</div>
            <div style="font-size:11px;color:#334155;margin-top:4px;">${escapeHtml(
              occ.depositType
            )}</div>
          </div>`
        );
        marker.addTo(group);
        markerLookupRef.current.set(`occ-${idx}-${occ.siteName}`, marker);
      });
    }

    if (showShops) {
      validShops.forEach((shop, idx) => {
        const pt: L.LatLngExpression = [shop.latitude, shop.longitude];
        boundsPoints.push(pt);

        if (hasUser && userLocation) {
          L.polyline(
            [
              [userLocation.latitude, userLocation.longitude],
              [shop.latitude, shop.longitude],
            ],
            {
              color: '#d97706',
              weight: 1.5,
              opacity: 0.45,
              dashArray: '3,4',
            }
          ).addTo(group);
        }

        const marker = L.marker(pt, {
          icon: createPinIcon('#d97706', '#ffffff', 16),
          zIndexOffset: 360,
        }).bindPopup(
          `<div style="min-width:225px;font-family:system-ui,sans-serif;">
            <div style="font-size:11px;font-weight:700;color:#b45309;">${escapeHtml(
              shop.shopType
            )} · ~${shop.distanceKm} km</div>
            <div style="font-size:13px;font-weight:700;color:#0f172a;margin-top:2px;">${escapeHtml(
              shop.name
            )}</div>
            <div style="font-size:11px;color:#065f46;font-weight:600;margin-top:4px;">User Availability: ${escapeHtml(
              shop.availability
            )}</div>
            <div style="font-size:11px;color:#475569;margin-top:4px;">${escapeHtml(
              shop.address
            )}</div>
            ${
              shop.phone
                ? `<div style="font-size:11px;color:#334155;margin-top:3px;">Tel: ${escapeHtml(
                    shop.phone
                  )}</div>`
                : ''
            }
          </div>`
        );
        marker.addTo(group);
        markerLookupRef.current.set(`shop-${shop.id}-${idx}`, marker);
      });
    }

    if (showOtherResources) {
      validOtherResources.forEach((item, idx) => {
        const pt: L.LatLngExpression = [item.latitude, item.longitude];
        boundsPoints.push(pt);

        const marker = L.marker(pt, {
          icon: createPinIcon('#7c3aed', '#ffffff', 15),
          zIndexOffset: 220,
        }).bindPopup(
          `<div style="min-width:210px;font-family:system-ui,sans-serif;">
            <div style="font-size:11px;font-weight:700;color:#6d28d9;">Other Nearby Resource · ~${
              item.distanceKm
            } km</div>
            <div style="font-size:13px;font-weight:700;color:#0f172a;margin-top:2px;">${escapeHtml(
              item.name
            )} (${escapeHtml(item.category)})</div>
            <div style="font-size:11px;color:#475569;margin-top:3px;">${escapeHtml(
              item.siteName
            )} · ${escapeHtml(item.country)}</div>
            <div style="font-size:11px;color:#334155;margin-top:4px;">${escapeHtml(
              item.depositType
            )}</div>
          </div>`
        );
        marker.addTo(group);
        markerLookupRef.current.set(`other-${item.slug}-${idx}`, marker);
      });
    }

    if (boundsPoints.length === 1) {
      map.setView(boundsPoints[0], 9, { animate: true });
    } else if (boundsPoints.length > 1) {
      // Focus zoom around user + closest shops & nearby regional pins without zooming out to whole globe unless all pins are distant
      const closePoints =
        hasUser && userLocation
          ? boundsPoints.filter((p) => {
              const [plat, plon] = p as [number, number];
              return (
                Math.abs(plat - userLocation.latitude) < 12 &&
                Math.abs(plon - userLocation.longitude) < 12
              );
            })
          : boundsPoints;

      const targetBounds = L.latLngBounds(
        closePoints.length >= 2 ? closePoints : boundsPoints
      );
      map.fitBounds(targetBounds, { padding: [44, 44], maxZoom: 12 });
    } else {
      map.setView([20, 15], 2);
    }
  }, [
    userLocation,
    validOccurrences,
    validShops,
    validOtherResources,
    showAskedSites,
    showShops,
    showOtherResources,
    resourceName,
  ]);

  const focusMarker = (key: string, lat: number, lon: number, zoom = 13) => {
    const map = mapRef.current;
    if (!map || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
    map.setView([lat, lon], zoom, { animate: true });
    const marker = markerLookupRef.current.get(key);
    if (marker) {
      marker.openPopup();
    }
    document.getElementById('nearby-availability-map')?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <section
      id="nearby-availability-map"
      className="bg-white border border-slate-200 rounded-xl overflow-hidden"
    >
      {/* Header & Direct User Location Controls */}
      <div className="p-5 border-b border-slate-200 bg-slate-50/75 space-y-3.5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-800">
              <Compass className="w-4 h-4 text-blue-700" />
              <span>Nearby User Availability &amp; Local Resource Map</span>
            </div>
            <h2 className="text-lg font-bold text-slate-900 mt-0.5">
              Nearby {resourceName}, Local Shops &amp; Other Available Resources Near You
            </h2>
            <p className="text-xs text-slate-600 mt-0.5">
              Separate from the global country map above — inspect nearest {resourceName} sites, customer-accessible resource shops &amp; hours, and other natural resources close to your location.
            </p>
          </div>

          {userLocation && (
            <button
              type="button"
              onClick={() => {
                persistUserLoc(null);
                onUpdateNearbyData({
                  userLocation: null,
                  nearestOccurrences: [],
                  nearbyShops: [],
                  nearbyOtherResources: [],
                });
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-100 rounded-md cursor-pointer shrink-0"
            >
              <X className="w-3.5 h-3.5" />
              <span>Clear Location</span>
            </button>
          )}
        </div>

        {/* Direct GPS + City Search Bar */}
        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={handleUseGps}
            disabled={loadingNearby}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors whitespace-nowrap shrink-0 disabled:opacity-50 cursor-pointer"
          >
            {loadingNearby ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Crosshair className="w-3.5 h-3.5" />
            )}
            <span>Use My GPS</span>
          </button>

          <form
            onSubmit={handleCitySearch}
            className="flex flex-1 min-w-[240px] items-center gap-2"
          >
            <div className="relative flex-1">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={cityQuery}
                onChange={(e) => setCityQuery(e.target.value)}
                placeholder="Enter your city or district (e.g., Hyderabad, Jaipur, Denver, Perth)…"
                aria-label="Enter city for nearby resource and shop availability map"
                className="w-full pl-8 pr-3 py-2 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:border-blue-700"
              />
            </div>
            <button
              type="submit"
              disabled={loadingNearby || cityQuery.trim().length < 2}
              className="px-3.5 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-300 hover:bg-slate-100 rounded-lg whitespace-nowrap disabled:opacity-50 cursor-pointer"
            >
              Find Nearby
            </button>
          </form>

          {userLocation && (
            <div className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-50 border border-blue-200 rounded-md text-xs font-medium text-blue-900">
              <MapPin className="w-3.5 h-3.5 text-blue-700 shrink-0" />
              <span>{userLocation.label}</span>
            </div>
          )}
        </div>

        {/* Layer Legend & Toggles */}
        <div className="flex flex-wrap items-center gap-2 text-xs pt-1">
          <span className="inline-flex items-center gap-1 text-slate-500 font-medium mr-1">
            <Layers className="w-3.5 h-3.5" />
            <span>Map Layers:</span>
          </span>

          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-blue-200 bg-blue-50 text-blue-900 font-medium">
            <span className="w-2.5 h-2.5 rounded-full bg-blue-600 inline-block" />
            <span>Your Location</span>
          </span>

          <button
            type="button"
            onClick={() => setShowShops((v) => !v)}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border font-medium cursor-pointer transition-colors ${
              showShops
                ? 'border-amber-300 bg-amber-50 text-amber-900'
                : 'border-slate-200 bg-white text-slate-400'
            }`}
          >
            <span className="w-2.5 h-2.5 rounded-full bg-amber-600 inline-block" />
            <span>
              {resourceName} Shops ({validShops.length})
            </span>
          </button>

          <button
            type="button"
            onClick={() => setShowAskedSites((v) => !v)}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border font-medium cursor-pointer transition-colors ${
              showAskedSites
                ? 'border-teal-300 bg-teal-50 text-teal-900'
                : 'border-slate-200 bg-white text-slate-400'
            }`}
          >
            <span className="w-2.5 h-2.5 rounded-full bg-teal-700 inline-block" />
            <span>
              Nearest {resourceName} Sites ({validOccurrences.length})
            </span>
          </button>

          <button
            type="button"
            onClick={() => setShowOtherResources((v) => !v)}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border font-medium cursor-pointer transition-colors ${
              showOtherResources
                ? 'border-violet-300 bg-violet-50 text-violet-900'
                : 'border-slate-200 bg-white text-slate-400'
            }`}
          >
            <span className="w-2.5 h-2.5 rounded-full bg-violet-600 inline-block" />
            <span>Other Nearby Resources ({validOtherResources.length})</span>
          </button>
        </div>

        {locError && (
          <div className="px-3 py-2 bg-rose-50 border border-rose-200 rounded-md text-xs text-rose-800">
            {locError}
          </div>
        )}
      </div>

      {/* Interactive Second Map Canvas */}
      <div className={`relative w-full ${heightClass} bg-slate-100`}>
        <div ref={mapElRef} className="w-full h-full z-0" />

        {!userLocation && !loadingNearby && (
          <div className="absolute inset-x-4 bottom-4 z-[400] bg-white/95 backdrop-blur-sm border border-slate-200 rounded-lg p-3.5 shadow-sm flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-slate-700">
              <strong className="text-slate-900">Set your location</strong> above (via{' '}
              <strong>Use My GPS</strong>, city search, or Chat) to map nearby{' '}
              <strong>{resourceName}</strong> sites, local shops with user availability, and other natural resources close to you.
            </div>
          </div>
        )}
      </div>

      {/* 3-Column Nearby Directory Cards Below Map */}
      {userLocation && (
        <div className="p-5 border-t border-slate-200 grid grid-cols-1 lg:grid-cols-3 gap-5 bg-slate-50/40">
          {/* Column 1: Resource Shops & User Availability */}
          <div className="bg-white border border-slate-200 rounded-lg p-4 flex flex-col space-y-3">
            <div className="flex items-center justify-between gap-2 pb-2 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <Store className="w-4 h-4 text-amber-600 shrink-0" />
                <h3 className="text-sm font-bold text-slate-900">
                  {resourceName} Shops &amp; User Availability
                </h3>
              </div>
              <span className="text-[11px] font-mono text-slate-500">
                {validShops.length} found
              </span>
            </div>

            {validShops.length > 0 ? (
              <div className="space-y-2.5 max-h-72 overflow-y-auto pr-1">
                {validShops.map((shop, idx) => (
                  <div
                    key={`${shop.id}-${idx}`}
                    onClick={() =>
                      focusMarker(`shop-${shop.id}-${idx}`, shop.latitude, shop.longitude, 14)
                    }
                    className="p-2.5 rounded-md border border-slate-200 hover:border-amber-500 hover:bg-amber-50/40 transition-colors cursor-pointer space-y-1"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-xs font-bold text-slate-900">{shop.name}</span>
                      <span className="text-[11px] font-mono font-semibold text-amber-700 shrink-0">
                        ~{shop.distanceKm} km
                      </span>
                    </div>
                    <div className="text-[11px] font-medium text-slate-600">{shop.shopType}</div>
                    <div className="inline-flex items-start gap-1 text-[11px] font-semibold text-emerald-800">
                      <Clock className="w-3 h-3 mt-0.5 shrink-0" />
                      <span>{shop.availability}</span>
                    </div>
                    <div className="text-[11px] text-slate-600 leading-snug">{shop.address}</div>
                    {(shop.phone || shop.website) && (
                      <div className="flex flex-wrap items-center gap-3 pt-1 text-[11px]">
                        {shop.phone && (
                          <span className="inline-flex items-center gap-1 text-slate-700 font-mono">
                            <Phone className="w-3 h-3" />
                            <span>{shop.phone}</span>
                          </span>
                        )}
                        {shop.website && (
                          <a
                            href={shop.website}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="inline-flex items-center gap-1 text-teal-800 hover:underline"
                          >
                            <span>Website</span>
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-slate-500 py-3">
                No mapped retail dealers matched inside ~35 km in OpenStreetMap for this locality. Try a nearby major city center.
              </p>
            )}
          </div>

          {/* Column 2: Nearest Available Sites of the Asked Resource */}
          <div className="bg-white border border-slate-200 rounded-lg p-4 flex flex-col space-y-3">
            <div className="flex items-center justify-between gap-2 pb-2 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <MapPin className="w-4 h-4 text-teal-700 shrink-0" />
                <h3 className="text-sm font-bold text-slate-900">
                  Nearest {resourceName} Sites
                </h3>
              </div>
              <span className="text-[11px] font-mono text-slate-500">
                {validOccurrences.length} mapped
              </span>
            </div>

            {validOccurrences.length > 0 ? (
              <div className="space-y-2.5 max-h-72 overflow-y-auto pr-1">
                {validOccurrences.map((occ, idx) => (
                  <div
                    key={`${occ.siteName}-${idx}`}
                    onClick={() =>
                      focusMarker(`occ-${idx}-${occ.siteName}`, occ.latitude, occ.longitude, 9)
                    }
                    className="p-2.5 rounded-md border border-slate-200 hover:border-teal-600 hover:bg-teal-50/40 transition-colors cursor-pointer space-y-1"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-xs font-bold text-slate-900">{occ.siteName}</span>
                      {typeof occ.distanceKm === 'number' && (
                        <span className="text-[11px] font-mono font-semibold text-teal-800 shrink-0">
                          ~{occ.distanceKm.toLocaleString()} km
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-slate-600">
                      {occ.country} · {occ.region}
                    </div>
                    <div className="text-[11px] text-slate-700">{occ.depositType}</div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-slate-500 py-3">
                No regional deposits recorded close to this coordinate for {resourceName}.
              </p>
            )}
          </div>

          {/* Column 3: Other Natural Resources Available Near User */}
          <div className="bg-white border border-slate-200 rounded-lg p-4 flex flex-col space-y-3">
            <div className="flex items-center justify-between gap-2 pb-2 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <Compass className="w-4 h-4 text-violet-700 shrink-0" />
                <h3 className="text-sm font-bold text-slate-900">
                  Other Nearby Natural Resources
                </h3>
              </div>
              <span className="text-[11px] font-mono text-slate-500">
                {validOtherResources.length} cataloged
              </span>
            </div>

            {validOtherResources.length > 0 ? (
              <div className="space-y-2.5 max-h-72 overflow-y-auto pr-1">
                {validOtherResources.map((item, idx) => (
                  <div
                    key={`${item.slug}-${idx}`}
                    onClick={() =>
                      focusMarker(`other-${item.slug}-${idx}`, item.latitude, item.longitude, 8)
                    }
                    className="p-2.5 rounded-md border border-slate-200 hover:border-violet-500 hover:bg-violet-50/40 transition-colors cursor-pointer space-y-1"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-xs font-bold text-slate-900">
                        {item.name}{' '}
                        <span className="font-normal text-slate-500">({item.category})</span>
                      </span>
                      <span className="text-[11px] font-mono font-semibold text-violet-700 shrink-0">
                        ~{item.distanceKm.toLocaleString()} km
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-600">
                      {item.siteName} · {item.country}
                    </div>
                    <div className="flex items-center justify-between gap-2 pt-0.5">
                      <span className="text-[11px] text-slate-700 truncate">
                        {item.depositType}
                      </span>
                      {onOpenResourceSlug && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenResourceSlug(item.slug);
                          }}
                          className="text-[11px] font-semibold text-teal-800 hover:underline whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          Open →
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-slate-500 py-3">
                Set your location above to rank nearby natural resources in the atlas.
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
};
