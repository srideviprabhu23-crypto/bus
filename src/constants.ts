import { Route } from "./types";

export const COIMBATORE_ROUTES: Route[] = [
  {
    id: "route-62",
    number: "62",
    name: "Ukkadam → Kovilpalayam",
    stops: [
      { name: "Ukkadam", lat: 10.9886, lng: 76.9616 },
      { name: "Town Hall", lat: 11.0160, lng: 76.9550 },
      { name: "Gandhipuram", lat: 11.0141, lng: 76.9669 },
      { name: "Lakshmi Mills", lat: 11.0089, lng: 76.9856 },
      { name: "Peelamedu", lat: 11.0234, lng: 77.0123 },
      { name: "Kovilpalayam", lat: 11.1354, lng: 77.0337 }
    ]
  },
  {
    id: "route-s25",
    number: "S25",
    name: "Kovaipudur → Gandhipuram",
    stops: [
      { name: "Kovaipudur", lat: 10.9345, lng: 76.9234 },
      { name: "Kuniyamuthur", lat: 10.9678, lng: 76.9456 },
      { name: "Ukkadam", lat: 10.9886, lng: 76.9616 },
      { name: "Town Hall", lat: 11.0160, lng: 76.9550 },
      { name: "Gandhipuram", lat: 11.0141, lng: 76.9669 }
    ]
  },
  {
    id: "route-101",
    number: "101",
    name: "Vadavalli → Railway Station",
    stops: [
      { name: "Vadavalli", lat: 11.0267, lng: 76.9058 },
      { name: "Lawley Road", lat: 11.0123, lng: 76.9345 },
      { name: "RS Puram", lat: 11.0089, lng: 76.9512 },
      { name: "Railway Station", lat: 10.9989, lng: 76.9667 }
    ]
  }
];
