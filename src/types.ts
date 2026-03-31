export interface Stop {
  name: string;
  lat: number;
  lng: number;
}

export interface Route {
  id: string;
  number: string;
  name: string;
  stops: Stop[];
}

export interface BusLocation {
  busId: string;
  routeId: string;
  lat: number;
  lng: number;
  speed: number;
  lastUpdate: number;
}

export interface ETAInfo {
  stopName: string;
  minutes: number;
  distance: number;
}
