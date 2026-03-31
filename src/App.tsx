/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap } from 'react-leaflet';
import { io, Socket } from 'socket.io-client';
import { 
  Bus, 
  MapPin, 
  Clock, 
  Navigation, 
  Search, 
  Info, 
  ChevronRight, 
  User, 
  Settings,
  AlertCircle,
  Map as MapIcon,
  Activity
} from 'lucide-react';
import L from 'leaflet';
import { motion, AnimatePresence } from 'motion/react';
import { COIMBATORE_ROUTES } from './constants';
import { Route, BusLocation, Stop, ETAInfo } from './types';
import { cn } from './lib/utils';

// Fix for Leaflet default icon issue in React
// @ts-ignore
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

const busIcon = new L.Icon({
  iconUrl: 'https://cdn-icons-png.flaticon.com/512/3448/3448339.png',
  iconSize: [32, 32],
  iconAnchor: [16, 16],
  popupAnchor: [0, -16],
});

const stopIcon = new L.Icon({
  iconUrl: 'https://cdn-icons-png.flaticon.com/512/149/149060.png',
  iconSize: [20, 20],
  iconAnchor: [10, 10],
});

// Helper to calculate distance between two points in km
function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371; // Radius of the earth in km
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function MapUpdater({ center }: { center: [number, number] }) {
  const map = useMap();
  useEffect(() => {
    map.setView(center);
  }, [center, map]);
  return null;
}

export default function App() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [selectedRoute, setSelectedRoute] = useState<Route>(COIMBATORE_ROUTES[0]);
  const [busLocations, setBusLocations] = useState<Record<string, BusLocation>>({});
  const [userLocation, setUserLocation] = useState<[number, number] | null>(null);
  const [isDriverMode, setIsDriverMode] = useState(false);
  const [isSharingLive, setIsSharingLive] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [mapCenter, setMapCenter] = useState<[number, number]>([11.0168, 76.9558]);
  const [etas, setEtas] = useState<ETAInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

  const driverBusId = "bus-driver-sim-1";
  const liveContributorId = useRef(`contributor-${Math.random().toString(36).substr(2, 9)}`);
  const driverIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const watchIdRef = useRef<number | null>(null);
  const selectedRouteRef = useRef(selectedRoute);

  // Sync ref with state to avoid closure issues in watchPosition
  useEffect(() => {
    selectedRouteRef.current = selectedRoute;
  }, [selectedRoute]);

  // Initialize Socket
  useEffect(() => {
    const newSocket = io();
    setSocket(newSocket);

    newSocket.on('all-bus-locations', (locations) => {
      setBusLocations(locations);
    });

    newSocket.on('bus-location-updated', (location: BusLocation) => {
      setBusLocations(prev => ({
        ...prev,
        [location.busId]: location
      }));
    });

    return () => {
      newSocket.close();
    };
  }, []);

  // Calculate ETAs for selected route
  useEffect(() => {
    const busOnRoute = (Object.values(busLocations) as BusLocation[]).find(b => b.routeId === selectedRoute.id);
    if (!busOnRoute) {
      setEtas([]);
      return;
    }

    const newEtas: ETAInfo[] = selectedRoute.stops.map(stop => {
      const distance = calculateDistance(busOnRoute.lat, busOnRoute.lng, stop.lat, stop.lng);
      // Simple ETA: 20km/h average speed
      const minutes = Math.round((distance / 20) * 60);
      return {
        stopName: stop.name,
        minutes,
        distance: Number(distance.toFixed(1))
      };
    });

    setEtas(newEtas);
  }, [busLocations, selectedRoute]);

  // Driver Simulation Logic
  const startSimulation = useCallback(() => {
    if (!socket) return;
    
    let stopIndex = 0;
    let progress = 0; // 0 to 1 between stops

    driverIntervalRef.current = setInterval(() => {
      const currentStop = selectedRoute.stops[stopIndex];
      const nextStop = selectedRoute.stops[(stopIndex + 1) % selectedRoute.stops.length];
      
      // Interpolate position
      const lat = currentStop.lat + (nextStop.lat - currentStop.lat) * progress;
      const lng = currentStop.lng + (nextStop.lng - currentStop.lng) * progress;

      socket.emit('update-bus-location', {
        busId: driverBusId,
        routeId: selectedRoute.id,
        lat,
        lng,
        speed: 25
      });

      progress += 0.05;
      if (progress >= 1) {
        progress = 0;
        stopIndex = (stopIndex + 1) % selectedRoute.stops.length;
      }
    }, 2000);
  }, [socket, selectedRoute]);

  const stopSimulation = useCallback(() => {
    if (driverIntervalRef.current) {
      clearInterval(driverIntervalRef.current);
      driverIntervalRef.current = null;
    }
  }, []);

  // Real Live Location Sharing Logic
  const startLiveSharing = useCallback(() => {
    if (!socket) return;
    if (!navigator.geolocation) {
      setError("Geolocation is not supported by your browser");
      return;
    }

    setIsSharingLive(true);
    watchIdRef.current = navigator.geolocation.watchPosition(
      (position) => {
        const { latitude, longitude, speed } = position.coords;
        const newPos: [number, number] = [latitude, longitude];
        setUserLocation(newPos);
        
        socket.emit('update-bus-location', {
          busId: liveContributorId.current,
          routeId: selectedRouteRef.current.id,
          lat: latitude,
          lng: longitude,
          speed: Math.round((speed || 0) * 3.6) // Convert m/s to km/h
        });
        
        // Only center once when starting to share
        setMapCenter(newPos);
      },
      (err) => {
        console.error(err);
        setError(`Location Error: ${err.message}`);
        setIsSharingLive(false);
      },
      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 10000
      }
    );
  }, [socket]);

  const stopLiveSharing = useCallback(() => {
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    setIsSharingLive(false);
  }, []);

  useEffect(() => {
    if (isDriverMode) {
      startSimulation();
    } else {
      stopSimulation();
    }
    return () => stopSimulation();
  }, [isDriverMode, startSimulation, stopSimulation]);

  const filteredRoutes = COIMBATORE_ROUTES.filter(r => 
    r.number.toLowerCase().includes(searchQuery.toLowerCase()) ||
    r.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="flex h-screen w-full overflow-hidden bg-slate-50">
      {/* Sidebar */}
      <aside className="w-80 flex-shrink-0 border-r border-slate-200 bg-white shadow-sm flex flex-col">
        <div className="p-6 border-bottom border-slate-100">
          <div className="flex items-center gap-3 mb-6">
            <div className="bg-blue-600 p-2 rounded-xl text-white">
              <Bus size={24} />
            </div>
            <h1 className="text-xl font-bold tracking-tight text-slate-900">Coimbatore Bus</h1>
          </div>

          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
            <input 
              type="text" 
              placeholder="Search route or number..." 
              className="w-full pl-10 pr-4 py-2.5 bg-slate-100 border-none rounded-xl text-sm focus:ring-2 focus:ring-blue-500 transition-all"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div>
            <h2 className="px-2 text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Available Routes</h2>
            <div className="space-y-1">
              {filteredRoutes.map(route => (
                <button
                  key={route.id}
                  onClick={() => {
                    setSelectedRoute(route);
                    setMapCenter([route.stops[0].lat, route.stops[0].lng]);
                  }}
                  className={cn(
                    "w-full flex items-center gap-4 p-3 rounded-xl transition-all text-left group",
                    selectedRoute.id === route.id 
                      ? "bg-blue-50 text-blue-700 ring-1 ring-blue-100" 
                      : "hover:bg-slate-50 text-slate-600"
                  )}
                >
                  <div className={cn(
                    "w-10 h-10 rounded-lg flex items-center justify-center font-bold text-sm",
                    selectedRoute.id === route.id ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-500"
                  )}>
                    {route.number}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-sm truncate">{route.name}</p>
                    <p className="text-xs opacity-70">{route.stops.length} stops</p>
                  </div>
                  <ChevronRight size={16} className={cn("transition-transform", selectedRoute.id === route.id ? "translate-x-1" : "opacity-0 group-hover:opacity-100")} />
                </button>
              ))}
            </div>
          </div>

          {(Object.values(busLocations) as BusLocation[]).filter(b => b.routeId === selectedRoute.id).length > 0 && (
            <div>
              <h2 className="px-2 text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Active Buses on Route</h2>
              <div className="space-y-2">
                {(Object.values(busLocations) as BusLocation[]).filter(b => b.routeId === selectedRoute.id).map(bus => (
                  <div key={bus.busId} className="bg-green-50 border border-green-100 p-3 rounded-xl flex items-center gap-3">
                    <div className="bg-green-500 p-2 rounded-lg text-white">
                      <Bus size={16} />
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center justify-between">
                        <p className="text-xs font-bold text-green-700">LIVE BUS</p>
                        <span className="text-[10px] text-green-600 font-medium animate-pulse">● LIVE</span>
                      </div>
                      <p className="text-[10px] text-green-600">{bus.speed} km/h • Updated just now</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="p-4 border-t border-slate-100 space-y-3">
          <div className="bg-slate-50 p-4 rounded-2xl border border-slate-100">
            <h3 className="text-sm font-bold text-slate-900 mb-1">Contribute Location</h3>
            <p className="text-[11px] text-slate-500 mb-3">On this bus? Share your live GPS to help others track it. <span className="text-blue-600 font-medium">(Requires GPS permission)</span></p>
            <button 
              onClick={() => isSharingLive ? stopLiveSharing() : startLiveSharing()}
              className={cn(
                "w-full flex items-center justify-center gap-2 py-2.5 rounded-xl font-semibold text-sm transition-all shadow-sm",
                isSharingLive 
                  ? "bg-red-500 text-white hover:bg-red-600 animate-pulse" 
                  : "bg-blue-600 text-white hover:bg-blue-700"
              )}
            >
              <MapPin size={16} />
              {isSharingLive ? "Sharing Live GPS..." : "Share My Location"}
            </button>
          </div>

          <button 
            onClick={() => setIsDriverMode(!isDriverMode)}
            className={cn(
              "w-full flex items-center justify-center gap-2 py-2.5 rounded-xl font-medium text-sm transition-all",
              isDriverMode 
                ? "bg-red-50 text-red-600 hover:bg-red-100" 
                : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            )}
          >
            {isDriverMode ? <Activity size={16} /> : <Navigation size={16} />}
            {isDriverMode ? "Stop Simulation" : "Simulation Mode"}
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col relative">
        {/* Error Toast */}
        <AnimatePresence>
          {error && (
            <motion.div 
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="absolute top-20 left-1/2 -translate-x-1/2 z-50 bg-white border border-red-100 shadow-2xl p-4 rounded-2xl max-w-md w-[90%]"
            >
              <div className="flex items-start gap-3">
                <div className="bg-red-100 p-2 rounded-lg text-red-600">
                  <AlertCircle size={20} />
                </div>
                <div className="flex-1">
                  <h4 className="text-sm font-bold text-slate-900">Location Access Required</h4>
                  <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                    {error.includes("denied") 
                      ? "It looks like location access was blocked. To share your live bus location, please click the lock icon in your browser address bar and set Location to 'Allow'." 
                      : error}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button 
                      onClick={() => {
                        setError(null);
                        startLiveSharing();
                      }}
                      className="text-xs bg-blue-600 text-white px-3 py-1.5 rounded-lg font-bold hover:bg-blue-700 transition-colors"
                    >
                      Try Again
                    </button>
                    <a 
                      href={window.location.href} 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="text-xs bg-slate-900 text-white px-3 py-1.5 rounded-lg font-bold hover:bg-slate-800 transition-colors flex items-center gap-1"
                    >
                      Open in New Tab
                      <ChevronRight size={12} />
                    </a>
                    <button 
                      onClick={() => setError(null)}
                      className="text-xs bg-slate-100 text-slate-600 px-3 py-1.5 rounded-lg font-bold hover:bg-slate-200 transition-colors"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        {/* Top Bar */}
        <header className="h-16 bg-white border-b border-slate-200 flex items-center justify-between px-6 z-10">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 text-slate-500">
              <MapIcon size={18} />
              <span className="text-sm font-medium">Live Map View</span>
            </div>
            <div className="h-4 w-px bg-slate-200" />
            <div className="flex items-center gap-2 text-blue-600 bg-blue-50 px-3 py-1 rounded-full text-xs font-semibold">
              <div className="w-2 h-2 bg-blue-600 rounded-full animate-pulse" />
              {Object.keys(busLocations).length} Buses Online
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button className="p-2 text-slate-400 hover:text-slate-600 transition-colors">
              <Settings size={20} />
            </button>
            <div className="w-8 h-8 bg-slate-200 rounded-full flex items-center justify-center text-slate-500">
              <User size={18} />
            </div>
          </div>
        </header>

        {/* Map Container */}
        <div className="flex-1 relative">
          <MapContainer 
            center={mapCenter} 
            zoom={13} 
            className="h-full w-full"
            zoomControl={false}
          >
            <TileLayer
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            />
            <MapUpdater center={mapCenter} />

            {/* User Location Marker */}
            {userLocation && (
              <Marker position={userLocation} icon={new L.Icon({
                iconUrl: 'https://cdn-icons-png.flaticon.com/512/235/235861.png',
                iconSize: [24, 24],
                iconAnchor: [12, 12],
              })}>
                <Popup>You are here</Popup>
              </Marker>
            )}

            {/* Route Line */}
            <Polyline 
              positions={selectedRoute.stops.map(s => [s.lat, s.lng])} 
              color="#3b82f6" 
              weight={4} 
              opacity={0.6}
              dashArray="10, 10"
            />

            {/* Stops */}
            {selectedRoute.stops.map((stop, idx) => (
              <Marker 
                key={`${selectedRoute.id}-stop-${idx}`} 
                position={[stop.lat, stop.lng]} 
                icon={stopIcon}
              >
                <Popup>
                  <div className="p-1">
                    <p className="font-bold text-slate-900">{stop.name}</p>
                    <p className="text-xs text-slate-500">Stop #{idx + 1}</p>
                  </div>
                </Popup>
              </Marker>
            ))}

            {/* Buses */}
            {(Object.values(busLocations) as BusLocation[]).map(bus => (
              <Marker 
                key={bus.busId} 
                position={[bus.lat, bus.lng]} 
                icon={busIcon}
              >
                <Popup>
                  <div className="p-2 min-w-[150px]">
                    <div className="flex items-center gap-2 mb-2">
                      <div className="bg-blue-600 text-white text-[10px] px-1.5 py-0.5 rounded font-bold">
                        {COIMBATORE_ROUTES.find(r => r.id === bus.routeId)?.number || "BUS"}
                      </div>
                      <p className="font-bold text-slate-900">Live Tracking</p>
                    </div>
                    <div className="space-y-1 text-xs text-slate-600">
                      <div className="flex justify-between">
                        <span>Speed:</span>
                        <span className="font-medium">{bus.speed} km/h</span>
                      </div>
                      <div className="flex justify-between">
                        <span>Last update:</span>
                        <span className="font-medium">Just now</span>
                      </div>
                    </div>
                  </div>
                </Popup>
              </Marker>
            ))}
          </MapContainer>

          {/* Floating ETA Panel */}
          <AnimatePresence>
            {etas.length > 0 && (
              <motion.div 
                initial={{ opacity: 0, y: 20, x: '-50%' }}
                animate={{ opacity: 1, y: 0, x: '-50%' }}
                exit={{ opacity: 0, y: 20, x: '-50%' }}
                className="absolute bottom-8 left-1/2 -translate-x-1/2 w-[90%] max-w-2xl bg-white/90 backdrop-blur-md border border-white/20 shadow-2xl rounded-2xl z-20 overflow-hidden"
              >
                <div className="p-4 bg-blue-600 text-white flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Clock size={20} />
                    <h3 className="font-bold">Upcoming Stops for Route {selectedRoute.number}</h3>
                  </div>
                  <div className="text-xs bg-white/20 px-2 py-1 rounded-full">
                    Live Updates
                  </div>
                </div>
                <div className="flex overflow-x-auto p-4 gap-4 no-scrollbar">
                  {etas.map((eta, idx) => (
                    <div 
                      key={idx} 
                      className={cn(
                        "flex-shrink-0 w-40 p-3 rounded-xl border transition-all",
                        eta.minutes <= 5 ? "bg-green-50 border-green-100" : "bg-slate-50 border-slate-100"
                      )}
                    >
                      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1 truncate">{eta.stopName}</p>
                      <div className="flex items-baseline gap-1">
                        <span className={cn(
                          "text-2xl font-black",
                          eta.minutes <= 5 ? "text-green-600" : "text-slate-900"
                        )}>{eta.minutes}</span>
                        <span className="text-xs font-medium text-slate-500">min</span>
                      </div>
                      <p className="text-[10px] text-slate-400 mt-1">{eta.distance} km away</p>
                    </div>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Map Controls */}
          <div className="absolute top-6 right-6 flex flex-col gap-2 z-10">
            <button className="w-10 h-10 bg-white shadow-lg rounded-xl flex items-center justify-center text-slate-600 hover:bg-slate-50 transition-all">
              <Navigation size={20} />
            </button>
            <button className="w-10 h-10 bg-white shadow-lg rounded-xl flex items-center justify-center text-slate-600 hover:bg-slate-50 transition-all">
              <Info size={20} />
            </button>
          </div>
        </div>

        {/* Footer Info */}
        <footer className="bg-white border-t border-slate-200 p-4 flex items-center justify-between text-xs text-slate-400">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1.5">
              <div className="w-2 h-2 bg-green-500 rounded-full" />
              <span>System Operational</span>
            </div>
            <div className="flex items-center gap-1.5">
              <AlertCircle size={14} />
              <span>Traffic data updated 2m ago</span>
            </div>
          </div>
          <p>&copy; 2026 Coimbatore Bus Tracking System. All rights reserved.</p>
        </footer>
      </main>
    </div>
  );
}
