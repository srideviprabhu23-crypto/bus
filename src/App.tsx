/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap } from 'react-leaflet';
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
  Activity,
  LogIn,
  LogOut,
  ExternalLink
} from 'lucide-react';
import L from 'leaflet';
import { motion, AnimatePresence } from 'motion/react';
import { 
  collection, 
  doc, 
  onSnapshot, 
  setDoc, 
  deleteDoc, 
  serverTimestamp,
  getDocFromServer
} from 'firebase/firestore';
import { 
  signInWithPopup, 
  GoogleAuthProvider, 
  onAuthStateChanged,
  signOut,
  User as FirebaseUser
} from 'firebase/auth';
import { db, auth } from './lib/firebase';
import firebaseConfig from '../firebase-applet-config.json';
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

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export default function App() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [selectedRoute, setSelectedRoute] = useState<Route>(COIMBATORE_ROUTES[0]);
  const [busLocations, setBusLocations] = useState<Record<string, BusLocation>>({});
  const [userLocation, setUserLocation] = useState<[number, number] | null>(null);
  const [isDriverMode, setIsDriverMode] = useState(false);
  const [isSharingLive, setIsSharingLive] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [mapCenter, setMapCenter] = useState<[number, number]>([11.0168, 76.9558]);
  const [etas, setEtas] = useState<ETAInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showDebug, setShowDebug] = useState(false);
  const [isLocating, setIsLocating] = useState(false);
  const [isDemoMode, setIsDemoMode] = useState(false);

  const driverBusId = "bus-driver-sim-1";
  const driverIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const watchIdRef = useRef<number | null>(null);
  const selectedRouteRef = useRef(selectedRoute);

  // Sync ref with state to avoid closure issues in watchPosition
  useEffect(() => {
    selectedRouteRef.current = selectedRoute;
  }, [selectedRoute]);

  // Firebase Auth Listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
    });
    return () => unsubscribe();
  }, []);

  // Test Connection to Firestore
  useEffect(() => {
    async function testConnection() {
      try {
        await getDocFromServer(doc(db, 'test', 'connection'));
        setIsConnected(true);
      } catch (error) {
        if(error instanceof Error && error.message.includes('the client is offline')) {
          setIsConnected(false);
        } else {
          // Other errors might still mean we are "connected" to the service
          setIsConnected(true);
        }
      }
    }
    testConnection();
  }, []);

  // Firestore Real-time Listener for Bus Locations
  useEffect(() => {
    const unsubscribe = onSnapshot(collection(db, 'bus_locations'), (snapshot) => {
      const locations: Record<string, BusLocation> = {};
      snapshot.forEach((doc) => {
        locations[doc.id] = doc.data() as BusLocation;
      });
      setBusLocations(locations);
    }, (err) => {
      console.error("Firestore Error:", err);
      try {
        handleFirestoreError(err, OperationType.LIST, 'bus_locations');
      } catch (e: any) {
        setError("Failed to sync live data. Check your connection.");
      }
    });

    return () => unsubscribe();
  }, []);

  const handleLogin = async () => {
    try {
      const provider = new GoogleAuthProvider();
      // Use signInWithPopup but handle common iframe/deployment errors
      await signInWithPopup(auth, provider);
      setError(null);
      setIsDemoMode(false);
    } catch (err: any) {
      console.error("Login Error:", err);
      if (err.code === 'auth/unauthorized-domain') {
        setIsDemoMode(true);
        setError(`Demo Mode Activated: The domain "${window.location.hostname}" is not authorized in Firebase. You can still use the app in Demo Mode, but live sharing with others requires authorization.`);
      } else if (err.code === 'auth/popup-blocked') {
        setIsDemoMode(true);
        setError("Demo Mode Activated: Login popup was blocked. You can still use the app in Demo Mode, or open it in a new tab to login.");
      } else if (err.code === 'auth/internal-error' || err.code === 'auth/network-request-failed') {
        setIsDemoMode(true);
        setError("Demo Mode Activated: Connection to Firebase failed. You can still use the app locally.");
      } else {
        setError(`Login failed: ${err.message}`);
      }
    }
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
      if (isSharingLive) stopLiveSharing();
    } catch (err: any) {
      console.error("Logout Error:", err);
    }
  };

  const updateLocationInFirestore = async (busId: string, data: any) => {
    // In Demo Mode, we only update local state, skipping Firestore
    if (isDemoMode) {
      setBusLocations(prev => ({
        ...prev,
        [busId]: { ...data, lastUpdate: Date.now() }
      }));
      return;
    }

    try {
      console.log(`Updating Firestore location for ${busId}:`, data);
      await setDoc(doc(db, 'bus_locations', busId), {
        ...data,
        lastUpdate: Date.now()
      });
    } catch (err: any) {
      console.error("Firestore Write Error:", err);
      try {
        handleFirestoreError(err, OperationType.WRITE, `bus_locations/${busId}`);
      } catch (e: any) {
        if (err.code === 'permission-denied') {
          setError("Permission denied. Please log in to share location.");
          setIsSharingLive(false);
        } else {
          setError(`Firestore Error: ${err.message}`);
        }
      }
    }
  };

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

  const startSimulation = useCallback(() => {
    if (isDriverMode) return;
    setIsDriverMode(true);
    
    let stopIndex = 0;
    let progress = 0; // 0 to 1 between stops

    driverIntervalRef.current = setInterval(() => {
      const currentStop = selectedRoute.stops[stopIndex];
      const nextStop = selectedRoute.stops[(stopIndex + 1) % selectedRoute.stops.length];
      
      // Interpolate position
      const lat = currentStop.lat + (nextStop.lat - currentStop.lat) * progress;
      const lng = currentStop.lng + (nextStop.lng - currentStop.lng) * progress;

      updateLocationInFirestore(driverBusId, {
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
  }, [selectedRoute, isDriverMode]);

  const stopSimulation = useCallback(() => {
    if (driverIntervalRef.current) {
      clearInterval(driverIntervalRef.current);
      driverIntervalRef.current = null;
    }
    setIsDriverMode(false);
    deleteDoc(doc(db, 'bus_locations', driverBusId));
  }, []);

  // Real Live Location Sharing Logic
  const startLiveSharing = useCallback(() => {
    if (!user) {
      setError("Please log in to share your location.");
      return;
    }
    if (!navigator.geolocation) {
      setError("Geolocation is not supported by your browser");
      return;
    }

    setIsSharingLive(true);
    setIsLocating(true);
    setError(null); // Clear previous errors

    // Check for secure context
    if (!window.isSecureContext) {
      setIsDemoMode(true);
      setError("Demo Mode Activated: Location sharing requires HTTPS. You can still use the app in Demo Mode.");
      setIsSharingLive(false);
      setIsLocating(false);
      return;
    }

    // Check permissions first if possible
    if (navigator.permissions && navigator.permissions.query) {
      navigator.permissions.query({ name: 'geolocation' as PermissionName }).then((result) => {
        if (result.state === 'denied') {
          setIsDemoMode(true);
          setError("Location Permission Denied: Access was denied. You can still use the app in Demo Mode, or click the lock icon in your address bar to allow access.");
          setIsSharingLive(false);
          setIsLocating(false);
        }
      }).catch(e => console.warn("Permissions API not supported for geolocation", e));
    }

    const options = {
      enableHighAccuracy: true,
      maximumAge: 30000,
      timeout: 30000
    };

    // First try to get current position to ensure it's working
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setIsLocating(false);
        const { latitude, longitude, speed } = position.coords;
        const newPos: [number, number] = [latitude, longitude];
        setUserLocation(newPos);
        setMapCenter(newPos);
        
        updateLocationInFirestore(user.uid, {
          busId: user.uid,
          routeId: selectedRouteRef.current.id,
          lat: latitude,
          lng: longitude,
          speed: Math.round((speed || 0) * 3.6)
        });

        // Now start watching
        watchIdRef.current = navigator.geolocation.watchPosition(
          (pos) => {
            const { latitude: lat, longitude: lng, speed: s } = pos.coords;
            const p: [number, number] = [lat, lng];
            setUserLocation(p);
            
            updateLocationInFirestore(user.uid, {
              busId: user.uid,
              routeId: selectedRouteRef.current.id,
              lat,
              lng,
              speed: Math.round((s || 0) * 3.6)
            });
          },
          (err) => {
            console.error("Watch Error:", err);
            // Don't stop sharing on a single watch error, just log it
          },
          options
        );
      },
      (err) => {
        console.error("Initial Position Error:", err);
        setIsLocating(false);
        setIsSharingLive(false);
        
        if (err.code === err.TIMEOUT) {
          setError("Location Timeout: It's taking too long to get your GPS fix. Try moving to an open area or using a mobile device.");
        } else if (err.code === err.PERMISSION_DENIED) {
          setError("Location Permission Denied: Please allow location access in your browser settings.");
        } else {
          setError(`Location Error: ${err.message}`);
        }
      },
      options
    );
  }, [user]);

  const stopLiveSharing = useCallback(() => {
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    setIsSharingLive(false);
    if (user) {
      deleteDoc(doc(db, 'bus_locations', user.uid));
    }
  }, [user]);

  const locateMe = useCallback(() => {
    if (!navigator.geolocation) {
      setError("Geolocation is not supported");
      return;
    }
    setIsLocating(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const newPos: [number, number] = [position.coords.latitude, position.coords.longitude];
        setUserLocation(newPos);
        setMapCenter(newPos);
        setIsLocating(false);
      },
      (err) => {
        setError(`Could not find location: ${err.message}`);
        setIsLocating(false);
      },
      { enableHighAccuracy: true }
    );
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

        <div className="flex-1 overflow-y-auto p-4 space-y-6">
          {/* Live Control Center */}
          <div className="bg-white rounded-2xl p-4 shadow-sm border border-slate-100 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className={cn("w-2 h-2 rounded-full animate-pulse", isSharingLive ? "bg-green-500" : "bg-slate-300")} />
                <span className="text-xs font-bold text-slate-900 uppercase tracking-wider">
                  {isSharingLive ? "Live Status: Online" : "Live Status: Offline"}
                </span>
              </div>
              <Activity size={16} className={isSharingLive ? "text-blue-600 animate-pulse" : "text-slate-300"} />
            </div>

            {!user ? (
              <div className="bg-blue-50 rounded-xl p-3 border border-blue-100">
                <p className="text-[11px] text-blue-700 leading-relaxed">
                  <strong>Want to share your location?</strong> Login with Google to help others track this route in real-time.
                </p>
              </div>
            ) : (
              <button
                onClick={isSharingLive ? stopLiveSharing : startLiveSharing}
                disabled={isLocating}
                className={cn(
                  "w-full py-3 rounded-xl font-bold text-sm transition-all shadow-md flex items-center justify-center gap-2",
                  isSharingLive 
                    ? "bg-red-50 text-red-600 border border-red-100 hover:bg-red-100" 
                    : "bg-blue-600 text-white hover:bg-blue-700",
                  isLocating && "opacity-70 cursor-not-allowed"
                )}
              >
                {isLocating ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    Locating...
                  </>
                ) : isSharingLive ? (
                  <>
                    <AlertCircle size={18} />
                    Stop Sharing Location
                  </>
                ) : (
                  <>
                    <Navigation size={18} />
                    Start Live Sharing
                  </>
                )}
              </button>
            )}
          </div>

          {/* Active Buses Section */}
          <div>
            <h2 className="px-2 text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3 flex items-center justify-between">
              Live Bus Activity
              <span className="bg-green-100 text-green-600 px-2 py-0.5 rounded-full text-[10px] font-bold">
                {Object.keys(busLocations).length} Online
              </span>
            </h2>
            <div className="space-y-2">
              {Object.keys(busLocations).length === 0 ? (
                <div className="px-2 py-4 border-2 border-dashed border-slate-100 rounded-2xl text-center">
                  <p className="text-[11px] text-slate-400 italic">No buses active yet. Be the first to share!</p>
                </div>
              ) : (
                (Object.values(busLocations) as BusLocation[])
                  .sort((a, b) => (b.lastUpdate || 0) - (a.lastUpdate || 0))
                  .map(bus => {
                  const route = COIMBATORE_ROUTES.find(r => r.id === bus.routeId);
                  const isMe = user && bus.busId === user.uid;
                  const secondsAgo = Math.floor((Date.now() - (bus.lastUpdate || Date.now())) / 1000);
                  
                  return (
                    <button 
                      key={bus.busId} 
                      onClick={() => setMapCenter([bus.lat, bus.lng])}
                      className={cn(
                        "w-full bg-white border p-3 rounded-xl flex items-center gap-3 transition-all hover:shadow-md text-left",
                        bus.routeId === selectedRoute.id ? "border-blue-200 bg-blue-50/30" : "border-slate-100",
                        isMe && "ring-2 ring-blue-500 ring-offset-2"
                      )}
                    >
                      <div className={cn(
                        "p-2 rounded-lg text-white",
                        bus.routeId === selectedRoute.id ? "bg-blue-600" : "bg-slate-400"
                      )}>
                        <Bus size={16} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between">
                          <p className="text-xs font-bold text-slate-900 truncate">
                            {isMe ? "My Device" : `Route ${route?.number || "???"}`}
                          </p>
                          <span className={cn(
                            "text-[10px] font-medium",
                            secondsAgo < 10 ? "text-green-600 animate-pulse" : "text-slate-400"
                          )}>
                            {secondsAgo < 5 ? "● JUST NOW" : `● ${secondsAgo}s ago`}
                          </span>
                        </div>
                        <p className="text-[10px] text-slate-500 truncate">{route?.name || "Tracking..."}</p>
                        <p className="text-[9px] text-slate-400 mt-1 font-mono uppercase tracking-tighter">
                          {bus.speed} km/h • {bus.busId.slice(0, 6)}
                        </p>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>

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
        </div>

          {/* Developer Tools Section */}
          <div className="space-y-3">
            <div className="flex items-center justify-between px-1">
              <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Developer Tools</h3>
              <div className="flex items-center gap-1 text-[10px] text-slate-400">
                <Info size={12} />
                <span>Simulation</span>
              </div>
            </div>
            
            <div className="bg-slate-50 rounded-2xl p-4 border border-slate-100 space-y-3">
              <button
                onClick={isDriverMode ? stopSimulation : startSimulation}
                className={cn(
                  "w-full py-2.5 rounded-xl font-bold text-xs transition-all flex items-center justify-center gap-2",
                  isDriverMode 
                    ? "bg-amber-50 text-amber-600 border border-amber-100" 
                    : "bg-white text-slate-600 border border-slate-200 hover:border-slate-300"
                )}
              >
                <Bus size={16} />
                {isDriverMode ? "Stop Simulation" : "Simulate Bus Movement"}
              </button>
            </div>
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
                  <h4 className="text-sm font-bold text-slate-900">
                    {error.includes("Demo Mode Activated") ? "Offline / Demo Mode" : 
                     error.includes("Permission Denied") ? "Location Permission Blocked" : 
                     error.includes("Location Access Required") ? "Location Access Required" : 
                     "System Message"}
                  </h4>
                  <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                    {error.includes("Permission Denied") ? (
                      <>
                        Location access was denied. 
                        {window.self !== window.top ? (
                          <> This often happens because the app is running in an <strong>iframe</strong>. Opening the app in a <strong>new tab</strong> usually fixes this.</>
                        ) : (
                          <> Please click the lock icon in your address bar to allow location access and then click <strong>Try Again</strong>.</>
                        )}
                      </>
                    ) : error}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {error.includes("Permission Denied") ? (
                      <>
                        {window.self !== window.top && (
                          <button 
                            onClick={() => window.open(window.location.href, '_blank')}
                            className="text-xs bg-blue-600 text-white px-3 py-1.5 rounded-lg font-bold hover:bg-blue-700 transition-colors flex items-center gap-1 shadow-sm"
                          >
                            <ExternalLink size={12} />
                            Open in New Tab (Recommended)
                          </button>
                        )}
                        <button 
                          onClick={() => {
                            setError(null);
                            startLiveSharing();
                          }}
                          className="text-xs bg-blue-600 text-white px-3 py-1.5 rounded-lg font-bold hover:bg-blue-700 transition-colors"
                        >
                          Try Again
                        </button>
                        <button 
                          onClick={() => {
                            if (!user) {
                              setError("Please log in to mock your location.");
                              return;
                            }
                            setIsSharingLive(true);
                            setIsDemoMode(true);
                            const center = mapCenter;
                            updateLocationInFirestore(user.uid, {
                              busId: user.uid,
                              routeId: selectedRoute.id,
                              lat: center[0],
                              lng: center[1],
                              speed: 0
                            });
                            setError("Mock Location Activated: You are now sharing your current map center as your location in Demo Mode.");
                          }}
                          className="text-xs bg-slate-100 text-slate-700 px-3 py-1.5 rounded-lg font-bold hover:bg-slate-200 transition-colors"
                        >
                          Use Mock Location
                        </button>
                        <button 
                          onClick={() => setError(null)}
                          className="text-xs bg-white border border-slate-200 text-slate-500 px-3 py-1.5 rounded-lg font-bold hover:bg-slate-50 transition-colors"
                        >
                          Dismiss
                        </button>
                      </>
                    ) : error.includes("Demo Mode Activated") ? (
                      <>
                        <button 
                          onClick={() => setError(null)}
                          className="text-xs bg-slate-900 text-white px-3 py-1.5 rounded-lg font-bold hover:bg-slate-800 transition-colors"
                        >
                          Got it
                        </button>
                        <button 
                          onClick={() => window.open(window.location.href, '_blank')}
                          className="text-xs bg-slate-100 text-slate-700 px-3 py-1.5 rounded-lg font-bold hover:bg-slate-200 transition-colors flex items-center gap-1"
                        >
                          <ExternalLink size={12} />
                          Open in New Tab
                        </button>
                      </>
                    ) : (
                      <>
                        {error.includes("Domain") && (
                          <button 
                            onClick={() => {
                              navigator.clipboard.writeText(window.location.hostname);
                              alert("Domain copied to clipboard!");
                            }}
                            className="text-xs bg-slate-100 text-slate-900 px-3 py-1.5 rounded-lg font-bold hover:bg-slate-200 transition-colors"
                          >
                            Copy Domain
                          </button>
                        )}
                        <button 
                          onClick={() => {
                            setError(null);
                            if (error.includes("Domain") || error.includes("Popup")) {
                              handleLogin();
                            } else {
                              startLiveSharing();
                            }
                          }}
                          className="text-xs bg-blue-600 text-white px-3 py-1.5 rounded-lg font-bold hover:bg-blue-700 transition-colors"
                        >
                          Try Again
                        </button>
                        <button 
                          onClick={() => setError(null)}
                          className="text-xs bg-white border border-slate-200 text-slate-500 px-3 py-1.5 rounded-lg font-bold hover:bg-slate-50 transition-colors"
                        >
                          Dismiss
                        </button>
                      </>
                    )}
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
            <div className={cn(
              "flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold transition-all",
              isConnected ? "text-green-600 bg-green-50" : "text-amber-600 bg-amber-50"
            )}>
              <div className={cn("w-2 h-2 rounded-full", isConnected ? "bg-green-600 animate-pulse" : "bg-amber-600")} />
              {isConnected ? "Connected" : "Reconnecting..."}
            </div>
            <div className="h-4 w-px bg-slate-200" />
            <div className="flex items-center gap-2 text-blue-600 bg-blue-50 px-3 py-1 rounded-full text-xs font-semibold">
              <div className="w-2 h-2 bg-blue-600 rounded-full animate-pulse" />
              {Object.keys(busLocations).length} Buses Online
            </div>
          </div>
          <div className="flex items-center gap-3">
            {user ? (
              <div className="flex items-center gap-3">
                <div className="hidden sm:flex flex-col items-end">
                  <span className="text-xs font-bold text-slate-900">{user.displayName}</span>
                  <button onClick={handleLogout} className="text-[10px] text-red-500 hover:underline">Logout</button>
                </div>
                <div className="w-8 h-8 bg-blue-100 rounded-full flex items-center justify-center text-blue-600 overflow-hidden border border-blue-200">
                  {user.photoURL ? (
                    <img src={user.photoURL} alt={user.displayName || ""} className="w-full h-full object-cover" />
                  ) : (
                    <User size={18} />
                  )}
                </div>
              </div>
            ) : (
              <button 
                onClick={handleLogin}
                className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-xl text-sm font-bold hover:bg-blue-700 transition-all shadow-md"
              >
                <LogIn size={16} />
                Login
              </button>
            )}
            <button className="p-2 text-slate-400 hover:text-slate-600 transition-colors">
              <Settings size={20} />
            </button>
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
              <Marker 
                position={userLocation} 
                icon={L.divIcon({
                  className: 'custom-user-icon',
                  html: `
                    <div class="relative">
                      <div class="absolute -inset-2 bg-blue-500/30 rounded-full animate-ping"></div>
                      <div class="relative bg-blue-600 p-2 rounded-full shadow-lg border-2 border-white text-white flex items-center justify-center">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                      </div>
                    </div>
                  `,
                  iconSize: [32, 32],
                  iconAnchor: [16, 16],
                })}
              >
                <Popup>
                  <div className="p-1 text-center">
                    <p className="font-bold text-blue-600">You are here</p>
                    <p className="text-[10px] text-slate-500">
                      {isSharingLive ? `Sharing live location on Route ${selectedRoute.number}` : "Current GPS Location"}
                    </p>
                  </div>
                </Popup>
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
            {(Object.values(busLocations) as BusLocation[])
              .map(bus => (
              <Marker 
                key={bus.busId} 
                position={[bus.lat, bus.lng]} 
                icon={L.divIcon({
                  className: 'custom-bus-icon',
                  html: `
                    <div class="relative">
                      <div class="absolute -inset-2 bg-blue-500/20 rounded-full animate-ping"></div>
                      <div class="relative bg-blue-600 p-2 rounded-lg shadow-lg border-2 border-white text-white flex items-center justify-center">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6v6"/><path d="M15 6v6"/><path d="M2 12h19.6"/><path d="M18 18h3s1-1.33 1-3c0-4.67-3.67-8-8-8H7c-4.33 0-8 3.33-8 8 0 1.67 1 3 1 3h3"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/></svg>
                      </div>
                    </div>
                  `,
                  iconSize: [32, 32],
                  iconAnchor: [16, 16],
                  popupAnchor: [0, -16],
                })}
              >
                <Popup>
                  <div className="p-2 min-w-[150px]">
                    <div className="flex items-center gap-2 mb-2">
                      <div className="bg-blue-600 text-white text-[10px] px-1.5 py-0.5 rounded font-bold">
                        {COIMBATORE_ROUTES.find(r => r.id === bus.routeId)?.number || "BUS"}
                      </div>
                      <p className="font-bold text-slate-900">
                        {user && bus.busId === user.uid ? "My Device" : "Live Tracking"}
                      </p>
                    </div>
                    <div className="space-y-1 text-xs text-slate-600">
                      <div className="flex justify-between">
                        <span>Speed:</span>
                        <span className="font-medium">{bus.speed} km/h</span>
                      </div>
                      <div className="flex justify-between">
                        <span>Last update:</span>
                        <span className="font-medium">
                          {Math.floor((Date.now() - (bus.lastUpdate || Date.now())) / 1000)}s ago
                        </span>
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

          {/* Debug Panel */}
        <div className="absolute top-4 right-4 z-[1000] flex flex-col items-end gap-2">
          <button 
            onClick={() => setShowDebug(!showDebug)}
            className="bg-slate-900/80 backdrop-blur-sm text-white p-2 rounded-full shadow-lg hover:bg-slate-900 transition-all"
          >
            <Settings size={20} className={cn(showDebug && "rotate-90 transition-transform")} />
          </button>
          
          <AnimatePresence>
            {showDebug && (
              <motion.div 
                initial={{ opacity: 0, scale: 0.9, y: -20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.9, y: -20 }}
                className="bg-white border border-slate-200 shadow-2xl rounded-2xl p-4 w-72 max-h-[80vh] overflow-y-auto"
              >
                <h3 className="text-sm font-bold text-slate-900 mb-3 flex items-center gap-2">
                  <Activity size={16} className="text-blue-600" />
                  System Diagnostics
                </h3>
                
                <div className="space-y-4">
                  <div className="space-y-1">
                    <p className="text-[10px] font-bold text-slate-400 uppercase">Connection</p>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-slate-600">Status:</span>
                      <span className={cn("text-xs font-bold", isConnected ? "text-green-600" : "text-red-600")}>
                        {isConnected ? "Connected" : "Disconnected"}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-slate-600">Socket ID:</span>
                      <span className="text-[10px] font-mono text-slate-400">Firebase Mode</span>
                    </div>
                  </div>

                  <div className="space-y-1">
                    <p className="text-[10px] font-bold text-slate-400 uppercase">Your Session</p>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-slate-600">Sharing:</span>
                      <span className={cn("text-xs font-bold", isSharingLive ? "text-blue-600" : "text-slate-400")}>
                        {isSharingLive ? "Active" : "Off"}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-slate-600">My ID:</span>
                      <span className="text-[10px] font-mono text-slate-400">{user?.uid || "Not Logged In"}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-slate-600">Demo Mode:</span>
                      <button 
                        onClick={() => {
                          setIsDemoMode(!isDemoMode);
                          if (!isDemoMode) setError(null);
                        }}
                        className={cn(
                          "px-2 py-0.5 rounded text-[10px] font-bold transition-colors",
                          isDemoMode ? "bg-amber-100 text-amber-600" : "bg-slate-100 text-slate-400"
                        )}
                      >
                        {isDemoMode ? "ON" : "OFF"}
                      </button>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <p className="text-[10px] font-bold text-slate-400 uppercase">Troubleshooting</p>
                    <div className="space-y-2">
                      <button 
                        onClick={async () => {
                          setIsConnected(false);
                          try {
                            await getDocFromServer(doc(db, 'test', 'connection'));
                            setIsConnected(true);
                            setError(null);
                          } catch (e: any) {
                            setIsConnected(false);
                            setError(`Connection Test Failed: ${e.message}`);
                          }
                        }}
                        className="w-full py-1.5 bg-slate-100 text-slate-600 rounded-lg text-[10px] font-bold hover:bg-slate-200 transition-colors flex items-center justify-center gap-2"
                      >
                        <Activity size={12} />
                        Test Connection
                      </button>
                      {!user && (
                        <button 
                          onClick={handleLogin}
                          className="w-full py-1.5 bg-blue-50 text-blue-600 rounded-lg text-[10px] font-bold hover:bg-blue-100 transition-colors flex items-center justify-center gap-2"
                        >
                          <LogIn size={12} />
                          Retry Login
                        </button>
                      )}
                      <button 
                        onClick={() => {
                          if (!user) {
                            setError("Please log in to mock your location.");
                            return;
                          }
                          setIsSharingLive(true);
                          setIsDemoMode(true);
                          const center = mapCenter;
                          updateLocationInFirestore(user.uid, {
                            busId: user.uid,
                            routeId: selectedRoute.id,
                            lat: center[0],
                            lng: center[1],
                            speed: 0
                          });
                          setError("Mock Location Activated: You are now sharing your current map center as your location in Demo Mode.");
                        }}
                        className="w-full py-1.5 bg-amber-50 text-amber-600 rounded-lg text-[10px] font-bold hover:bg-amber-100 transition-colors flex items-center justify-center gap-2"
                      >
                        <Navigation size={12} />
                        Mock My Location (Demo)
                      </button>
                      <button 
                        onClick={() => window.open(window.location.href, '_blank')}
                        className="w-full py-1.5 bg-slate-900 text-white rounded-lg text-[10px] font-bold hover:bg-slate-800 transition-colors flex items-center justify-center gap-2"
                      >
                        <ChevronRight size={12} />
                        Open in New Tab (Fixes most issues)
                      </button>
                      <div className="p-2 bg-amber-50 border border-amber-100 rounded-lg space-y-2">
                        <p className="text-[9px] text-amber-700 leading-tight">
                          <strong>Note:</strong> If login fails after deployment, ensure <code>{window.location.hostname}</code> is added to "Authorized Domains" in Firebase Console.
                        </p>
                        <div className="flex gap-1">
                          <button 
                            onClick={() => {
                              navigator.clipboard.writeText(window.location.hostname);
                              alert("Domain copied to clipboard!");
                            }}
                            className="flex-1 py-1 bg-amber-100 text-amber-700 rounded text-[8px] font-bold hover:bg-amber-200 transition-colors"
                          >
                            Copy Domain
                          </button>
                          <a 
                            href={`https://console.firebase.google.com/project/${firebaseConfig.projectId}/authentication/providers`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex-1 py-1 bg-amber-600 text-white rounded text-[8px] font-bold hover:bg-amber-700 transition-colors text-center"
                          >
                            Go to Console
                          </a>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <p className="text-[10px] font-bold text-slate-400 uppercase">Active Data ({Object.keys(busLocations).length})</p>
                    <div className="bg-slate-50 rounded-lg p-2 max-h-40 overflow-y-auto">
                      <pre className="text-[9px] text-slate-500 font-mono">
                        {JSON.stringify(busLocations, null, 2)}
                      </pre>
                    </div>
                  </div>

                  <button 
                    onClick={() => window.location.reload()}
                    className="w-full py-2 bg-slate-100 text-slate-600 rounded-lg text-xs font-bold hover:bg-slate-200 transition-colors"
                  >
                    Hard Refresh App
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Map Controls */}
          <div className="absolute top-6 right-6 flex flex-col gap-2 z-10">
            <button 
              onClick={locateMe}
              disabled={isLocating}
              className={cn(
                "w-10 h-10 bg-white shadow-lg rounded-xl flex items-center justify-center transition-all",
                isLocating ? "text-blue-600 animate-pulse" : "text-slate-600 hover:bg-slate-50"
              )}
              title="Locate Me"
            >
              <MapPin size={20} />
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
