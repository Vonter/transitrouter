import { h, render, Component, Fragment } from 'preact';
import { toGeoJSON } from '@mapbox/polyline';
import Fuse from 'fuse.js';
import intersect from 'just-intersect';
import CheapRuler from 'cheap-ruler';

import { MAPBOX_ACCESS_TOKEN } from './config';
import { encode, decode } from './utils/specialID';
import { sortServices } from './utils/bus';
import fetchCache from './utils/fetchCache';
import getRoute from './utils/getRoute';
import getDistance from './utils/getDistance';
import getWalkingMinutes from './utils/getWalkingMinutes';
import { setRafInterval, clearRafInterval } from './utils/rafInterval';

import Ad from './ad';
import BusServicesArrival from './components/BusServicesArrival';
import GeolocateControl from './components/GeolocateControl';
import BetweenRoutes from './components/BetweenRoutes';
import ScrollableContainer from './components/ScrollableContainer';

import stopImagePath from './images/stop.png';
import stopEndImagePath from './images/stop-end.png';
import openNewWindowImagePath from './images/open-new-window.svg';
import passingRoutesImagePath from './images/passing-routes.svg';
import iconSVGPath from '../icons/icon.svg';
import busTinyImagePath from './images/bus-tiny.png';

const dataPath = 'https://data.busrouter.sg/v1/';
const routesJSONPath = dataPath + 'routes.min.json';
const stopsJSONPath = dataPath + 'stops.min.json';
const servicesJSONPath = dataPath + 'services.min.json';

const APP_NAME = 'BusRouter SG';
const APP_LONG_NAME = 'Singapore Bus Routes Explorer';
const $map = document.getElementById('map');
const STORE = {};
const BREAKPOINT = () => window.innerWidth > 640;
const supportsHover =
  window.matchMedia && window.matchMedia('(hover: hover)').matches;
const supportsPromise = 'Promise' in window;
const ruler = new CheapRuler(1.3);

const $logo = document.getElementById('logo');
const $about = document.getElementById('about');
const $closeAbout = document.getElementById('close-about');

const redirectToOldSite = () => {
  const redirect = confirm(
    'Looks like your browser is a little old. Redirecting you to the older version of BusRouter SG.',
  );
  if (redirect) location.href = 'https://v1.busrouter.sg/';
};

if (!supportsPromise || !mapboxgl.supported()) {
  redirectToOldSite();
}

$closeAbout.onclick = $logo.onclick = () => {
  $about.hidden = !$about.hidden;
  try {
    localStorage.setItem('busroutersg.about', 'true');
  } catch (e) {}
};
try {
  const intro = localStorage.getItem('busroutersg.about');
  if (intro !== 'true') $about.hidden = false;
} catch (e) {}

let rafST;
const rafScrollTop = () => {
  window.scrollTo(0, 0);
  rafST = requestAnimationFrame(rafScrollTop);
};

const $tooltip = document.getElementById('tooltip');
function showStopTooltip(data) {
  $tooltip.innerHTML = `<span class="stop-tag">${data.number}</span> ${data.name}`;
  $tooltip.classList.add('show');
  const { x, y: top } = data;
  const left = Math.max(
    5,
    Math.min(window.innerWidth - $tooltip.offsetWidth - 5, x - 5),
  );
  $tooltip.style.transform = `translate(${left}px, ${top}px)`;
}
function hideStopTooltip() {
  $tooltip.classList.remove('show');
}

window.requestIdleCallback =
  window.requestIdleCallback || ((cb) => setTimeout(cb, 1));

class App extends Component {
  constructor() {
    super();
    const route = getRoute();
    this.state = {
      prevRoute: null,
      route,
      routeLoading: route.page !== 'home',
      services: [],
      stops: [],
      searching: false,
      expandSearch: false,
      expandedSearchOnce: false,
      shrinkSearch: false,
      showStopPopover: false,
      showBetweenPopover: false,
      showArrivalsPopover: false,
      intersectStops: 0,
      betweenStartStop: null,
      betweenEndStop: null,
      showAd: false,
      liveBusCount: 0,
    };

    window.onhashchange = () => {
      this.setState({
        prevRoute: this.state.route,
        route: getRoute(),
      });
    };
  }
  async componentDidMount() {
    const CACHE_TIME = 24 * 60; // 1 day
    const fetchStopsP = fetchCache(stopsJSONPath, CACHE_TIME);
    const fetchServicesP = fetchCache(servicesJSONPath, CACHE_TIME);
    const fetchRoutesP = fetchCache(routesJSONPath, CACHE_TIME);

    // Init data

    const stops = await fetchStopsP;
    const stopsData = {};
    const stopsDataArr = [];
    Object.keys(stops).forEach((number) => {
      const [lng, lat, name] = stops[number];
      stopsData[number] = {
        name,
        number,
        interchange:
          /\sint$/i.test(name) && !/^(bef|aft|opp|bet)\s/i.test(name),
        coordinates: [lng, lat],
        services: [],
        routes: [],
      };
      stopsDataArr.push(stopsData[number]);
    });
    stopsDataArr.sort((a, b) => (a.interchange ? 1 : b.interchange ? -1 : 0));

    const servicesData = await fetchServicesP;
    const servicesDataArr = [];
    Object.keys(servicesData).forEach((number) => {
      const { name, routes } = servicesData[number];
      servicesDataArr.push({
        number,
        name,
      });
      routes.forEach((route, i) => {
        route.forEach((stop) => {
          if (stopsData[stop] && !stopsData[stop].services.includes(number)) {
            stopsData[stop].services.push(number);
            stopsData[stop].routes.push(number + '-' + i);
          }
        });
      });
    });
    servicesDataArr.sort((a, b) => sortServices(a.number, b.number));

    const routesData = await fetchRoutesP;
    const data = (window._data = {
      servicesData,
      stopsData,
      stopsDataArr,
      routesData,
      servicesDataArr,
    });
    this.setState({ ...data, services: servicesDataArr });

    mapboxgl.accessToken = MAPBOX_ACCESS_TOKEN;
    const lowerLat = 1.2,
      upperLat = 1.48,
      lowerLong = 103.59,
      upperLong = 104.05;
    const map = (this.map = window._map = new mapboxgl.Map({
      container: 'map',
      style: 'mapbox://styles/cheeaun/ckn18umqw1jsi17nymmpdinba',
      renderWorldCopies: false,
      boxZoom: false,
      minZoom: 8,
      logoPosition: 'top-right',
      attributionControl: false,
      pitchWithRotate: false,
      dragRotate: false,
      touchPitch: false,
      bounds: [lowerLong, lowerLat, upperLong, upperLat],
      fitBoundsOptions: {
        padding: BREAKPOINT()
          ? 120
          : { top: 40, bottom: window.innerHeight / 2, left: 40, right: 40 },
      },
    }));
    map.touchZoomRotate.disableRotation();

    // Controls
    map.addControl(
      new mapboxgl.AttributionControl({
        compact: true,
      }),
      'top-right',
    );
    map.addControl(
      new mapboxgl.NavigationControl({
        showCompass: false,
      }),
      'top-right',
    );
    map.addControl(
      new GeolocateControl({
        offset: () => {
          if (BREAKPOINT() || !this.state.showStopPopover) return [0, 0];
          return [0, -this._stopPopover.offsetHeight / 2];
        },
      }),
    );

    let initialMoveStart = false;
    const initialHideSearch = () => {
      if (initialMoveStart) return;
      initialMoveStart = true;
      $logo.classList.add('fadeout');
      this.setState({
        shrinkSearch: true,
      });
    };
    map.once('dragstart', initialHideSearch);
    map.once('zoomstart', initialHideSearch);

    const mapCanvas = map.getCanvas();

    let labelLayerId;
    const [_, stopImage, stopEndImage] = await Promise.all([
      new Promise((resolve, reject) => {
        map.once('styledata', () => {
          const layers = map.getStyle().layers;
          console.log(layers);

          labelLayerId = layers.find(
            (l) => l.type == 'symbol' && l.layout['text-field'],
          ).id;

          resolve();
        });
      }),
      new Promise((resolve, reject) => {
        map.loadImage(stopImagePath, (e, img) =>
          e ? reject(e) : resolve(img),
        );
      }),
      new Promise((resolve, reject) => {
        map.loadImage(stopEndImagePath, (e, img) =>
          e ? reject(e) : resolve(img),
        );
      }),
    ]);

    this.labelLayerId = labelLayerId;

    if (window.performance) {
      const timeSincePageLoad = Math.round(performance.now());
      gtag('event', 'timing_complete', {
        name: 'load',
        value: timeSincePageLoad,
        event_category: 'Map',
      });
    }

    map.addImage('stop', stopImage);
    map.addImage('stop-end', stopEndImage);

    map.addSource('stops', {
      type: 'geojson',
      tolerance: 10,
      buffer: 0,
      data: {
        type: 'FeatureCollection',
        features: stopsDataArr.map((stop) => ({
          type: 'Feature',
          id: encode(stop.number),
          properties: {
            number: stop.number,
            name: stop.name,
            interchange: stop.interchange,
          },
          geometry: {
            type: 'Point',
            coordinates: stop.coordinates,
          },
        })),
      },
    });

    const stopTextPartialFormat = ['get', 'number'];
    const stopTextFullFormat = [
      'format',
      ['get', 'number'],
      { 'font-scale': 0.8 },
      '\n',
      {},
      ['get', 'name'],
      { 'text-color': '#000' },
    ];
    const stopText = {
      layout: {
        'text-optional': true,
        'text-field': [
          'step',
          ['zoom'],
          '',
          15,
          stopTextPartialFormat,
          16,
          stopTextFullFormat,
        ],
        'text-size': ['step', ['zoom'], 12, 16, 14],
        'text-justify': 'auto',
        'text-variable-anchor': ['left', 'right'],
        'text-radial-offset': 1,
        'text-padding': 0.5,
        'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Regular'],
        'text-max-width': 16,
        'text-line-height': 1.1,
      },
      paint: {
        'text-color': '#f01b48',
        'text-halo-width': 1,
        'text-halo-color': '#fff',
      },
    };

    map.addLayer(
      {
        id: 'stops',
        type: 'circle',
        source: 'stops',
        layout: {
          visibility: 'none',
        },
        paint: {
          'circle-radius': [
            'interpolate',
            ['linear'],
            ['zoom'],
            10,
            [
              'case',
              ['boolean', ['feature-state', 'selected'], false],
              4,
              0.75,
            ],
            14,
            4,
            15,
            ['case', ['boolean', ['feature-state', 'selected'], false], 12, 6],
          ],
          'circle-color': [
            'case',
            ['boolean', ['feature-state', 'selected'], false],
            '#fff',
            '#f01b48',
          ],
          'circle-stroke-color': [
            'case',
            ['boolean', ['feature-state', 'selected'], false],
            '#f01b48',
            '#fff',
          ],
          'circle-stroke-width': [
            'case',
            ['boolean', ['feature-state', 'selected'], false],
            5,
            1,
          ],
          'circle-opacity': [
            'interpolate',
            ['linear'],
            ['zoom'],
            10,
            1,
            13.9,
            1,
            14,
            0.5,
          ],
          'circle-stroke-opacity': [
            'interpolate',
            ['linear'],
            ['zoom'],
            10,
            ['case', ['boolean', ['feature-state', 'selected'], false], 1, 0],
            13.5,
            1,
            14,
            0.5,
          ],
        },
      },
      'settlement-subdivision-label',
    );

    map.addLayer({
      id: 'stops-icon',
      type: 'symbol',
      source: 'stops',
      filter: ['any', ['>=', ['zoom'], 14], ['get', 'interchange']],
      layout: {
        visibility: 'none',
        // 'symbol-z-order': 'source',
        'icon-image': 'stop',
        'icon-size': ['step', ['zoom'], 0.4, 15, 0.5, 16, 0.6],
        'icon-padding': 0.5,
        'icon-allow-overlap': true,
        // 'icon-ignore-placement': true,
        ...stopText.layout,
      },
      paint: {
        'icon-opacity': [
          'interpolate',
          ['linear'],
          ['zoom'],
          8,
          ['case', ['get', 'interchange'], 1, 0],
          14,
          1,
        ],
        ...stopText.paint,
      },
    });

    requestIdleCallback(() => {
      map.on('mouseenter', 'stops', () => {
        mapCanvas.style.cursor = 'pointer';
      });
      map.on('click', (e) => {
        if (e.originalEvent.altKey) {
          console.log(e.lngLat);
        }
        const { point } = e;
        const features = map.queryRenderedFeatures(point, {
          layers: ['stops', 'stops-icon', 'stops-highlight'],
          validate: false,
        });
        if (features.length) {
          const zoom = map.getZoom();
          const feature = features[0];
          const center = feature.geometry.coordinates;
          if (zoom < 12) {
            // Slowly zoom in first
            map.flyTo({ zoom: zoom + 2, center });
            this.setState({
              shrinkSearch: true,
            });
          } else {
            if (feature.source == 'stops') {
              location.hash = `/stops/${feature.properties.number}`;
            } else {
              this._showStopPopover(feature.properties.number);
            }
          }
        } else {
          const { page, subpage } = this.state.route;
          if (page === 'stop' && subpage !== 'routes') {
            location.hash = '/';
          } else {
            this._hideStopPopover();
          }
        }
      });
      let lastFrame = null;
      if (supportsHover) {
        let lastFeature = null;
        map.on('mousemove', (e) => {
          const { point } = e;
          const features = map.queryRenderedFeatures(point, {
            layers: ['stops', 'stops-highlight'],
            validate: false,
          });
          if (features.length && map.getZoom() < 16 && !map.isMoving()) {
            if (lastFeature && features[0].id === lastFeature.id) {
              return;
            }
            lastFeature = features[0];
            const stopID = decode(features[0].id);
            const data = stopsData[stopID];
            if (lastFrame) cancelAnimationFrame(lastFrame);
            lastFrame = requestAnimationFrame(() => {
              showStopTooltip({
                ...data,
                ...point,
              });
            });
          } else if (lastFeature) {
            lastFeature = null;
            hideStopTooltip();
          }
        });
      }
      map.on('mouseleave', 'stops', () => {
        mapCanvas.style.cursor = '';
        if (lastFrame) cancelAnimationFrame(lastFrame);
        requestAnimationFrame(hideStopTooltip);
      });
      map.on('mouseout', hideStopTooltip);
      map.on('movestart', hideStopTooltip);
    });

    map.addSource('stops-highlight', {
      type: 'geojson',
      tolerance: 10,
      buffer: 0,
      data: {
        type: 'FeatureCollection',
        features: [],
      },
    });
    map.addLayer({
      id: 'stops-highlight-circle',
      type: 'circle',
      source: 'stops-highlight',
      minzoom: 11,
      maxzoom: 14,
      filter: ['!=', ['get', 'type'], 'end'],
      paint: {
        'circle-radius': ['step', ['zoom'], 1.5, 12, 2],
        'circle-color': '#fff',
        'circle-stroke-color': '#f01b48',
        'circle-stroke-width': ['step', ['zoom'], 1.5, 12, 2],
      },
    });
    map.addLayer({
      id: 'stops-highlight',
      type: 'symbol',
      source: 'stops-highlight',
      filter: ['any', ['>=', ['zoom'], 14], ['==', ['get', 'type'], 'end']],
      layout: {
        'icon-image': [
          'case',
          ['==', ['get', 'type'], 'end'],
          'stop-end',
          'stop',
        ],
        'icon-size': [
          'step',
          ['zoom'],
          0.3,
          10,
          ['case', ['==', ['get', 'type'], 'end'], 0.3, 0.45],
          15,
          ['case', ['==', ['get', 'type'], 'end'], 0.45, 0.6],
        ],
        'icon-anchor': [
          'case',
          ['==', ['get', 'type'], 'end'],
          'bottom',
          'center',
        ],
        'icon-padding': 0.5,
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        ...stopText.layout,
        'text-field': [
          'step',
          ['zoom'],
          ['case', ['==', ['get', 'type'], 'end'], stopTextFullFormat, ''],
          14,
          [
            'case',
            ['==', ['get', 'type'], 'end'],
            stopTextFullFormat,
            stopTextPartialFormat,
          ],
          16,
          stopTextFullFormat,
        ],
        'text-size': [
          'step',
          ['zoom'],
          ['case', ['==', ['get', 'type'], 'end'], 14, 11],
          16,
          14,
        ],
      },
      paint: {
        ...stopText.paint,
        'text-halo-width': ['case', ['==', ['get', 'type'], 'end'], 2, 1],
      },
    });
    map.addLayer(
      {
        id: 'stops-highlight-selected',
        type: 'circle',
        source: 'stops-highlight',
        filter: ['any', ['>', ['zoom'], 10], ['==', ['get', 'type'], 'end']],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 4, 15, 12],
          'circle-color': '#fff',
          'circle-stroke-color': '#f01b48',
          'circle-stroke-width': 5,
          'circle-opacity': [
            'case',
            ['boolean', ['feature-state', 'selected'], false],
            0.5,
            0,
          ],
          'circle-stroke-opacity': [
            'case',
            ['boolean', ['feature-state', 'selected'], false],
            0.5,
            0,
          ],
        },
      },
      'stops-highlight',
    );

    requestIdleCallback(() => {
      map.on('mouseenter', 'stops-highlight', () => {
        mapCanvas.style.cursor = 'pointer';
      });
      map.on('mouseleave', 'stops-highlight', () => {
        mapCanvas.style.cursor = '';
      });
    });

    // Bus service routes
    map.addSource('routes', {
      type: 'geojson',
      tolerance: 1,
      buffer: 0,
      lineMetrics: true,
      data: {
        type: 'FeatureCollection',
        features: [],
      },
    });

    map.addLayer(
      {
        id: 'routes-bg',
        type: 'line',
        source: 'routes',
        layout: {
          'line-cap': 'round',
        },
        paint: {
          'line-color': '#fff',
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 12, 1, 22, 0],
          'line-width': 6,
          'line-offset': [
            'interpolate',
            ['linear'],
            ['zoom'],
            12,
            0,
            16,
            -3,
            22,
            ['*', ['zoom'], -3],
          ],
        },
      },
      labelLayerId,
    );

    map.addLayer(
      {
        id: 'routes',
        type: 'line',
        source: 'routes',
        layout: {
          'line-cap': 'round',
        },
        paint: {
          'line-color': '#f01b48',
          'line-gradient': [
            'interpolate',
            ['linear'],
            ['line-progress'],
            0,
            '#f01b48',
            0.5,
            '#972FFE',
            1,
            '#f01b48',
          ],
          'line-opacity': [
            'interpolate',
            ['linear'],
            ['zoom'],
            12,
            0.9,
            16,
            0.4,
          ],
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            12,
            2,
            16,
            5,
            22,
            10,
          ],
          'line-offset': [
            'interpolate',
            ['linear'],
            ['zoom'],
            12,
            0,
            16,
            -3,
            22,
            ['*', ['zoom'], -3],
          ],
        },
      },
      labelLayerId,
    );

    map.addLayer({
      id: 'route-arrows',
      type: 'symbol',
      source: 'routes',
      minzoom: 12,
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 100,
        'text-field': '→',
        'text-size': 16,
        'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Regular'],
        'text-allow-overlap': true,
        'text-ignore-placement': true,
        'text-keep-upright': false,
        'text-anchor': 'bottom',
        'text-padding': 0,
        'text-line-height': 1,
        'text-offset': [
          'interpolate',
          ['linear'],
          ['zoom'],
          12,
          ['literal', [0, 0]],
          22,
          ['literal', [0, -2]],
        ],
      },
      paint: {
        'text-color': '#5301a4',
        'text-opacity': 0.9,
        'text-halo-color': '#fff',
        'text-halo-width': 2,
      },
    });

    // Bus service routes (passing, overlapping)
    map.addSource('routes-path', {
      type: 'geojson',
      tolerance: 1,
      buffer: 0,
      lineMetrics: true,
      data: {
        type: 'FeatureCollection',
        features: [],
      },
    });

    map.addLayer(
      {
        id: 'routes-path',
        type: 'line',
        source: 'routes-path',
        layout: {
          'line-cap': 'round',
        },
        paint: {
          'line-color': '#f01b48',
          'line-gradient': [
            'interpolate',
            ['linear'],
            ['line-progress'],
            0,
            '#f01b48',
            0.5,
            '#972FFE',
            1,
            '#f01b48',
          ],
          'line-opacity': [
            'case',
            ['boolean', ['feature-state', 'hover'], false],
            1,
            ['boolean', ['feature-state', 'fadein'], false],
            0.07,
            0.7, // default
          ],
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            12,
            2,
            16,
            5,
            22,
            10,
          ],
        },
      },
      'stops-highlight',
    );

    map.addLayer(
      {
        id: 'routes-path-bg',
        type: 'line',
        source: 'routes-path',
        layout: {
          'line-cap': 'round',
        },
        maxzoom: 20,
        paint: {
          'line-color': [
            'case',
            ['boolean', ['feature-state', 'fadein'], false],
            'transparent',
            '#fff',
          ],
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            12,
            6,
            16,
            10,
            22,
            16,
          ],
        },
      },
      'routes-path',
    );

    map.addLayer({
      id: 'route-path-labels',
      type: 'symbol',
      source: 'routes-path',
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 100,
        'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Regular'],
        'text-field': '{service}',
        'text-size': 12,
        'text-rotation-alignment': 'viewport',
        'text-padding': 0,
        'text-line-height': 1,
      },
      paint: {
        'text-color': '#3f5711',
        'text-halo-color': '#eeffd1',
        'text-halo-width': 2,
        'text-opacity': [
          'case',
          ['boolean', ['feature-state', 'fadein'], false],
          0.1,
          1,
        ],
      },
    });

    requestIdleCallback(() => {
      let hoveredRouteID;
      map.on('mouseenter', 'routes-path', () => {
        mapCanvas.style.cursor = 'pointer';
      });
      map.on('click', 'routes-path', (e) => {
        if (e.features.length) {
          const { id } = e.features[0];
          location.hash = `/services/${decode(id)}`;
        }
      });
      map.on('mousemove', 'routes-path', (e) => {
        if (e.features.length) {
          const currentHoveredRouteID = e.features[0].id;
          if (hoveredRouteID && hoveredRouteID === currentHoveredRouteID)
            return;

          if (hoveredRouteID) {
            map.setFeatureState(
              {
                source: 'routes-path',
                id: hoveredRouteID,
              },
              { hover: false, fadein: false },
            );
          }

          hoveredRouteID = currentHoveredRouteID;
          map.setFeatureState(
            {
              source: 'routes-path',
              id: hoveredRouteID,
            },
            { hover: true, fadein: false },
          );

          STORE.routesPathServices.forEach((service) => {
            const id = encode(service);
            if (hoveredRouteID === id) return;
            map.setFeatureState(
              {
                source: 'routes-path',
                id,
              },
              { hover: false, fadein: true },
            );
          });

          this._highlightRouteTag(decode(hoveredRouteID));
        }
      });
      map.on('mouseleave', 'routes-path', () => {
        mapCanvas.style.cursor = '';
        if (hoveredRouteID) {
          STORE.routesPathServices.forEach((service) => {
            const id = encode(service);
            map.setFeatureState(
              {
                source: 'routes-path',
                id,
              },
              { fadein: false, hover: false },
            );
          });
          hoveredRouteID = null;
          this._highlightRouteTag();
        }
      });
    });

    // Traffic
    map.addSource('traffic', {
      type: 'vector',
      url: 'mapbox://mapbox.mapbox-traffic-v1',
    });

    // Service live buses
    map.addSource('buses-service', {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: [],
      },
    });
    map.loadImage(busTinyImagePath, (e, img) => {
      map.addImage('bus-tiny', img);
    });
    map.addLayer({
      id: 'buses-service',
      type: 'symbol',
      source: 'buses-service',
      minzoom: 9,
      layout: {
        'icon-image': 'bus-tiny',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'icon-size': ['step', ['zoom'], 0.3, 14, 0.35, 15, 0.45, 16, 0.55],
      },
    });

    // Between routes
    map.addSource('routes-between', {
      type: 'geojson',
      tolerance: 1,
      buffer: 0,
      data: {
        type: 'FeatureCollection',
        features: [],
      },
    });

    map.addLayer(
      {
        id: 'routes-between',
        type: 'line',
        source: 'routes-between',
        filter: ['!=', ['get', 'type'], 'walk'],
        layout: {
          'line-cap': 'round',
        },
        paint: {
          'line-color': [
            'match',
            ['get', 'type'],
            'start',
            '#f01b48',
            'end',
            '#972FFE',
            '#f01b48',
          ],
          'line-opacity': 0.7,
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            12,
            2,
            16,
            5,
            22,
            10,
          ],
          'line-offset': [
            'interpolate',
            ['linear'],
            ['zoom'],
            12,
            0,
            16,
            -3,
            22,
            ['*', ['zoom'], -3],
          ],
        },
      },
      labelLayerId,
    );

    map.addLayer(
      {
        id: 'routes-between-walk',
        type: 'line',
        source: 'routes-between',
        filter: ['==', ['get', 'type'], 'walk'],
        paint: {
          'line-color': '#007aff',
          'line-dasharray': [2, 2],
          'line-opacity': 0.7,
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            12,
            2,
            16,
            5,
            22,
            10,
          ],
        },
      },
      'stops-highlight',
    );

    map.addLayer(
      {
        id: 'routes-between-bg',
        type: 'line',
        source: 'routes-between',
        layout: {
          'line-cap': 'round',
        },
        maxzoom: 14,
        paint: {
          'line-color': '#fff',
          'line-width': 6,
        },
      },
      'routes-between',
    );

    map.addLayer({
      id: 'route-between-arrows',
      type: 'symbol',
      source: 'routes-between',
      minzoom: 12,
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 100,
        'text-field': '→',
        'text-size': 16,
        'text-allow-overlap': true,
        'text-ignore-placement': true,
        'text-keep-upright': false,
        'text-anchor': 'bottom',
        'text-padding': 0,
        'text-line-height': 1,
        'text-offset': [
          'interpolate',
          ['linear'],
          ['zoom'],
          12,
          ['literal', [0, 0]],
          22,
          ['literal', [0, -2]],
        ],
      },
      paint: {
        'text-color': '#5301a4',
        'text-opacity': 0.8,
        'text-halo-color': '#fff',
        'text-halo-width': 2,
      },
    });

    this._renderRoute();

    requestIdleCallback(() => {
      // Popover search field
      this._fuseServices = new Fuse(servicesDataArr, {
        threshold: 0.3,
        keys: ['number', 'name'],
      });
      this._fuseStops = new Fuse(stopsDataArr, {
        threshold: 0.3,
        keys: ['number', 'name'],
      });

      // Global shortcuts
      document.addEventListener('keydown', (e) => {
        const isFormField =
          e.target &&
          e.target.tagName &&
          /input|textarea|button|select/i.test(e.target.tagName);
        const keydown = e.key.toLowerCase();
        switch (keydown) {
          case '/': {
            if (isFormField) return;
            e.preventDefault();
            this._searchField.focus();
            break;
          }
          case 'escape': {
            const {
              expandSearch,
              showStopPopover,
              showBetweenPopover,
            } = this.state;
            if (expandSearch) {
              this._handleSearchClose();
            } else if (showStopPopover) {
              this._hideStopPopover();
            } else if (showBetweenPopover) {
              location.hash = '/';
            }
            break;
          }
          default: {
            if (e.shiftKey && e.altKey) {
              document.body.classList.add('alt-mode');
            }
          }
        }
      });
      document.addEventListener('keyup', () => {
        document.body.classList.remove('alt-mode');
      });

      // For cases when user already typed something before fuse.js inits
      if (this._searchField.value) this._handleSearch();

      // Finally, show ad
      map.once('idle', () => {
        setTimeout(() => {
          this.setState({
            showAd: true,
          });
        }, 1000);
      });
    });
  }
  _handleKeys = (e) => {
    switch (e.key.toLowerCase()) {
      case 'enter': {
        const link = this._servicesList.querySelector('li a[href^="#"]');
        if (link) {
          this._searchField.blur();
          link.click();
        }
        break;
      }
    }
  };
  _handleSearchFocus = (e) => {
    this.setState({ expandSearch: true, expandedSearchOnce: true });
    $map.classList.add('fade-out');
    rafScrollTop();
    this._searchPopover.addEventListener('transitionend', (e) => {
      cancelAnimationFrame(rafST);
    });
  };
  _handleSearch = (e) => {
    const { value } = (e && e.target) || this._searchField;
    if (value) {
      const services = this._fuseServices.search(value);
      let stops = [];
      if (services.length < 20) {
        stops = this._fuseStops.search(value);
      }
      this.setState({
        services: services.map((s) => s.item),
        stops: stops.map((s) => s.item),
        searching: true,
      });
      // Scroll to top, with hack for momentum scrolling
      // https://popmotion.io/blog/20170704-manually-set-scroll-while-ios-momentum-scroll-bounces/
      this._servicesList.style['-webkit-overflow-scrolling'] = 'auto';
      this._servicesList.scrollTop = 0;
      this._servicesList.style['-webkit-overflow-scrolling'] = null;
    } else {
      this.setState({
        services: this.state.servicesDataArr,
        stops: [],
        searching: false,
      });
    }
  };
  _handleSearchClose = () => {
    this.setState({
      expandSearch: false,
    });
    $map.classList.remove('fade-out');
    this._resetSearch();
  };
  _resetSearch = () => {
    this._searchField.blur();
    this._searchField.value = '';
    this.setState({
      searching: false,
      services: this.state.servicesDataArr,
      stops: [],
    });
  };
  _handleServicesScroll = () => {
    if (this.state.expandSearch) return;
    this.setState({ expandSearch: true, expandedSearchOnce: true });
    $map.classList.add('fade-out');
  };
  _showStopPopover = (number) => {
    const map = this.map;
    const { stopsData, prevStopNumber, route } = this.state;
    const { services, coordinates, name } = stopsData[number];

    const popoverHeight = this._stopPopover.offsetHeight;
    const offset = BREAKPOINT() ? [0, 0] : [0, -popoverHeight / 2];
    const zoom = map.getZoom();
    if (zoom < 16) {
      map.flyTo({
        zoom: 16,
        center: coordinates,
        offset,
        animate: zoom >= 12,
      });
    } else {
      map.easeTo({ center: coordinates, offset });
    }

    if (prevStopNumber) {
      this.map.setFeatureState(
        {
          source: 'stops',
          id: encode(prevStopNumber),
        },
        {
          selected: false,
        },
      );
      this.map.setFeatureState(
        {
          source: 'stops-highlight',
          id: encode(prevStopNumber),
        },
        {
          selected: false,
        },
      );
    }
    map.setFeatureState(
      {
        source: 'stops',
        id: encode(number),
      },
      {
        selected: true,
      },
    );
    map.setFeatureState(
      {
        source: 'stops-highlight',
        id: encode(number),
      },
      {
        selected: true,
      },
    );

    const labelLayerId = this.labelLayerId;

    this.setState(
      {
        shrinkSearch: true,
        prevStopNumber: number,
        showStopPopover: {
          number,
          name,
          services,
        },
      },
      () => {
        requestAnimationFrame(() => {
          if (popoverHeight === this._stopPopover.offsetHeight) return;
          const offset = BREAKPOINT()
            ? [0, 0]
            : [0, -this._stopPopover.offsetHeight / 2];
          const zoom = map.getZoom();
          if (zoom < 16) {
            map.flyTo({
              zoom: 16,
              center: coordinates,
              offset,
              animate: zoom >= 12,
            });
          } else {
            map.easeTo({ center: coordinates, offset });
          }

          const { page } = route;
          if (page === 'stop' && !map.getLayer('traffic')) {
            requestAnimationFrame(() => {
              map.addLayer(
                {
                  id: 'traffic',
                  type: 'line',
                  source: 'traffic',
                  'source-layer': 'traffic',
                  minzoom: 14,
                  filter: [
                    'all',
                    ['==', '$type', 'LineString'],
                    ['has', 'congestion'],
                  ],
                  layout: {
                    'line-join': 'round',
                    'line-cap': 'round',
                  },
                  paint: {
                    'line-width': 3,
                    'line-offset': [
                      'case',
                      [
                        'match',
                        ['get', 'class'],
                        ['link', 'motorway_link', 'service', 'street'],
                        true,
                        false,
                      ],
                      6,
                      [
                        'match',
                        ['get', 'class'],
                        ['secondary', 'tertiary'],
                        true,
                        false,
                      ],
                      6,
                      ['==', 'class', 'primary'],
                      12,
                      ['==', 'class', 'trunk'],
                      12,
                      ['==', 'class', 'motorway'],
                      9,
                      6,
                    ],
                    'line-color': [
                      'match',
                      ['get', 'congestion'],
                      'low',
                      'rgba(36, 218, 26, .2)',
                      'moderate',
                      'rgba(253, 149, 0, .55)',
                      'heavy',
                      'rgba(252, 77, 77, .65)',
                      'severe',
                      'rgba(148, 41, 76, .75)',
                      'transparent',
                    ],
                    'line-opacity': [
                      'interpolate',
                      ['linear'],
                      ['zoom'],
                      14.1,
                      0,
                      16,
                      1,
                    ],
                  },
                },
                labelLayerId,
              );
            });
          }
        });
      },
    );
  };
  _hideStopPopover = (e) => {
    const { page, subpage } = this.state.route;
    if (e && (page !== 'stop' || subpage === 'routes')) {
      e.preventDefault();
    }
    const map = this.map;
    let { number } = this.state.showStopPopover;
    number = number || this.state.prevStopNumber;
    if (number) {
      map.setFeatureState(
        {
          source: 'stops',
          id: encode(number),
        },
        {
          selected: false,
        },
      );
      map.setFeatureState(
        {
          source: 'stops-highlight',
          id: encode(number),
        },
        {
          selected: false,
        },
      );
    }
    this.setState({
      showStopPopover: false,
    });
    setTimeout(() => {
      if (
        map.getLayer('traffic') &&
        (page !== 'stop' || (page === 'stop' && subpage === 'routes'))
      ) {
        map.removeLayer('traffic');
      }
    }, 500);
  };
  _closeServicesPopover = (e) => {
    const { prevRoute } = this.state;
    if (prevRoute && prevRoute.page === 'stop') {
      e.preventDefault();
      history.back();
    }
  };
  _zoomToStop = () => {
    const map = this.map;
    const { stopsData, showStopPopover } = this.state;
    const { number } = showStopPopover;
    const { coordinates } = stopsData[number];
    const offset = BREAKPOINT()
      ? [0, 0]
      : [0, -this._stopPopover.offsetHeight / 2];
    const zoom = map.getZoom();
    if (zoom < 16) {
      map.flyTo({
        zoom: 16,
        center: coordinates,
        offset,
      });
    } else {
      map.easeTo({ center: coordinates, offset });
    }
  };
  _highlightRouteTag = (service) => {
    const $servicesList = this._floatPill.querySelector('.services-list');
    if (!$servicesList) return;
    if (service) {
      const otherServices = $servicesList.querySelectorAll('.service-tag');
      otherServices.forEach((el) => {
        el.classList.remove('highlight');
        if (el.textContent.trim() === service.trim()) {
          el.style.opacity = '';
        } else {
          el.style.opacity = 0.3;
        }
      });
    } else {
      $servicesList
        .querySelectorAll('.service-tag')
        .forEach((el) => (el.style.opacity = ''));
    }
  };
  _clickRoute = (e, service) => {
    const { target } = e;
    e.stopPropagation();
    if (target.classList.contains('highlight')) return;
    e.preventDefault();
    target.classList.add('highlight');
    this._highlightRoute(null, service, true);
  };
  _highlightRoute = (e, service, zoomIn) => {
    const map = this.map;

    if (e) e.target.classList.remove('highlight');
    const hoveredRouteID = encode(service);
    map.setFeatureState(
      {
        source: 'routes-path',
        id: hoveredRouteID,
      },
      { hover: true, fadein: false },
    );

    STORE.routesPathServices.forEach((service) => {
      const id = encode(service);
      if (hoveredRouteID === id) return;
      map.setFeatureState(
        {
          source: 'routes-path',
          id,
        },
        { hover: false, fadein: true },
      );
    });

    if (zoomIn) {
      // Fit map to route bounds
      requestAnimationFrame(() => {
        const { servicesData, stopsData } = this.state;
        const { routes } = servicesData[service];
        const coordinates = routes[0]
          .concat(routes[1] || [])
          .map((stop) => stopsData[stop].coordinates);
        const bounds = new mapboxgl.LngLatBounds();
        coordinates.forEach((c) => {
          bounds.extend(c);
        });
        const bottom = this._floatPill
          ? this._floatPill.offsetHeight + 60 + 80
          : 80;
        map.fitBounds(bounds, {
          padding: BREAKPOINT()
            ? 80
            : {
                top: 80,
                right: 80,
                bottom,
                left: 80,
              },
        });
      });
    }
  };
  _unhighlightRoute = (e) => {
    if (e && e.target && e.target.classList.contains('service-tag')) {
      e.target.classList.remove('highlight');
    }
    STORE.routesPathServices.forEach((service) => {
      const id = encode(service);
      this.map.setFeatureState(
        {
          source: 'routes-path',
          id,
        },
        { fadein: false, hover: false },
      );
    });
  };
  _openBusArrival = (e, showPopup = false) => {
    if (e) e.preventDefault();
    const width = 360;
    const height = 480;
    const url = e.target.href;
    const stopNumber = url.match(/[^#]+$/)[0];
    showPopup =
      showPopup ||
      (window.innerWidth > width * 2 && window.innerHeight > height) ||
      window.innerWidth > window.innerHeight; // landscape is weird
    if (showPopup) {
      const top = ((screen.availHeight || screen.height) - height) / 2;
      const left = (screen.width - width) / 2;
      window.open(
        url,
        `busArrivals-${stopNumber}`,
        `width=${width},height=${height},menubar=0,toolbar=0,top=${top},left=${left}`,
      );
    } else {
      this.setState(
        {
          showArrivalsPopover: {
            webviewURL: url,
            number: stopNumber,
          },
        },
        () => {
          $map.classList.add('fade-out');
        },
      );
    }
  };
  _closeBusArrival = (e) => {
    if (e) e.preventDefault();
    this.setState(
      {
        showArrivalsPopover: false,
      },
      () => {
        $map.classList.remove('fade-out');
      },
    );
  };
  _showBetweenPopover = (data) => {
    this.setState(
      {
        shrinkSearch: true,
        showBetweenPopover: data,
      },
      () => {
        // Auto-select first result
        setTimeout(() => {
          const firstResult = this._betweenPopover.querySelector(
            '.between-item',
          );
          firstResult.click();
        }, 300);
      },
    );
  };
  _previewRAF;
  _cannotPreviewRoute = () => {
    const { page, subpage, value } = this.state.route;
    return (
      subpage === 'routes' ||
      (page === 'service' && value.split('~').length > 1)
    );
  };
  _previewRoute = (service) => {
    cancelAnimationFrame(this._previewRAF);
    if (this._cannotPreviewRoute()) return;
    this._previewRAF = requestAnimationFrame(() => {
      const { routesData } = this.state;
      const routes = routesData[service];
      const geometries = routes.map((route) => toGeoJSON(route));
      this.map.getSource('routes-path').setData({
        type: 'FeatureCollection',
        features: geometries.map((geometry) => ({
          type: 'Feature',
          id: encode(service),
          properties: {
            service,
          },
          geometry,
        })),
      });
    });
  };
  _unpreviewRoute = () => {
    cancelAnimationFrame(this._previewRAF);
    if (this._cannotPreviewRoute()) return;
    this.map.getSource('routes-path').setData({
      type: 'FeatureCollection',
      features: [],
    });
  };
  _renderBetweenRoute = ({ e, startStop, endStop, result }) => {
    const { target } = e;
    target.parentElement.parentElement
      .querySelectorAll('.between-item')
      .forEach((el) => {
        if (el === target) {
          target.classList.add('selected');
        } else {
          el.classList.remove('selected');
        }
      });

    const map = this.map;
    const { stopsData, routesData } = this.state;
    const stops = [
      { ...startStop, end: true },
      { ...endStop, end: true },
    ];
    if (result.startStop && result.startStop.number != startStop.number) {
      stops.push({ ...result.startStop, end: true });
    }
    if (result.endStop && result.endStop.number != endStop.number) {
      stops.push({ ...result.endStop, end: true });
    }
    if (result.stopsBetween.length) {
      result.stopsBetween.forEach((number) => stops.push(stopsData[number]));
    }

    // Render stops
    map.getSource('stops-highlight').setData({
      type: 'FeatureCollection',
      features: stops.map((stop) => ({
        type: 'Feature',
        id: encode(stop.number),
        properties: {
          name: stop.name,
          number: stop.number,
          type: stop.end ? 'end' : null,
        },
        geometry: {
          type: 'Point',
          coordinates: stop.coordinates,
        },
      })),
    });

    requestAnimationFrame(() => {
      // Render routes
      const geometries = [];

      let [service, index] = result.startRoute.split('-');
      geometries.push(toGeoJSON(routesData[service][index]));

      if (result.endRoute) {
        let [service, index] = result.endRoute.split('-');
        geometries.push(toGeoJSON(routesData[service][index]));
      }

      if (result.startStop && result.startStop.number != startStop.number) {
        geometries.push({
          type: 'LineString',
          coordinates: [result.startStop.coordinates, startStop.coordinates],
        });
      }
      if (result.endStop && result.endStop.number != endStop.number) {
        geometries.push({
          type: 'LineString',
          coordinates: [result.endStop.coordinates, endStop.coordinates],
        });
      }
      map.getSource('routes-between').setData({
        type: 'FeatureCollection',
        features: geometries.map((geometry, i) => ({
          type: 'Feature',
          properties: {
            type: i === 0 ? 'start' : i === 1 ? 'end' : 'walk',
          },
          geometry,
        })),
      });

      // Fit map to stops bounds
      const bounds = new mapboxgl.LngLatBounds();
      stops.forEach((stop) => {
        bounds.extend(stop.coordinates);
      });
      map.fitBounds(bounds, {
        padding: BREAKPOINT()
          ? {
              top: 80,
              right: this._betweenPopover.offsetWidth + 80,
              bottom: 80,
              left: 80,
            }
          : {
              top: 80,
              right: 80,
              bottom: this._betweenPopover.offsetHeight + 80,
              left: 80,
            },
      });
    });
  };
  _liveBusesTimeout;
  _renderRoute = () => {
    const {
      servicesData,
      stopsData,
      stopsDataArr,
      routesData,
      route,
      prevStopNumber,
    } = this.state;
    const map = this.map;
    console.log('Route', route);

    // Reset everything
    $map.classList.remove('fade-out');
    this.setState({
      showStopPopover: false,
      showBetweenPopover: false,
      liveBusCount: 0,
    });
    [
      'stops-highlight',
      'routes',
      'routes-path',
      'routes-between',
      'buses-service',
    ].forEach((source) => {
      map.getSource(source).setData({
        type: 'FeatureCollection',
        features: [],
      });
    });
    if (prevStopNumber) {
      this._hideStopPopover();
    }
    clearRafInterval(this._liveBusesTimeout);

    switch (route.page) {
      case 'service': {
        const servicesValue = route.value;
        const services = servicesValue
          .split('~')
          .filter((s) => servicesData[s]);
        if (!services.length) return; // No value or none of the service codes are valid

        // Reset
        this.setState({
          expandSearch: false,
          shrinkSearch: true,
        });
        this._resetSearch();

        // Hide all stops
        map.setLayoutProperty('stops', 'visibility', 'none');
        map.setLayoutProperty('stops-icon', 'visibility', 'none');

        if (services.length === 1) {
          const service = services[0];
          const { name, routes } = servicesData[service];
          document.title = `Bus service ${service}: ${name} - ${APP_NAME}`;

          // Show stops of the selected service
          const endStops = [routes[0][0], routes[0][routes[0].length - 1]];
          if (routes[1])
            endStops.push(routes[1][0], routes[1][routes[1].length - 1]);
          let routeStops = [...routes[0], ...(routes[1] || [])].filter(
            (el, pos, arr) => {
              return arr.indexOf(el) == pos;
            },
          ); // Merge and unique

          // Fit map to route bounds
          const bounds = new mapboxgl.LngLatBounds();
          routeStops.forEach((stop) => {
            const { coordinates } = stopsData[stop];
            bounds.extend(coordinates);
          });
          map.fitBounds(bounds, {
            padding: BREAKPOINT()
              ? 80
              : {
                  top: 80,
                  right: 80,
                  bottom: 60 + 54 + 80, // height of search bar + float pill
                  left: 80,
                },
          });

          map.getSource('stops-highlight').setData({
            type: 'FeatureCollection',
            features: routeStops.map((stop, i) => {
              const { name } = stopsData[stop];
              return {
                type: 'Feature',
                id: encode(stop),
                properties: {
                  name,
                  number: stop,
                  type: endStops.includes(stop) ? 'end' : null,
                },
                geometry: {
                  type: 'Point',
                  coordinates: stopsData[stop].coordinates,
                },
              };
            }),
          });

          // Show routes
          requestAnimationFrame(() => {
            const routes = routesData[service];
            const geometries = routes.map((route) => toGeoJSON(route));
            map.getSource('routes').setData({
              type: 'FeatureCollection',
              features: geometries.map((geometry) => ({
                type: 'Feature',
                properties: {},
                geometry,
              })),
            });

            const fetchBuses = async () => {
              const buses = await fetchCache(
                `https://arrivelah2.busrouter.sg/service/?stops=${routeStops.join(
                  ',',
                )}&service=${service}`,
                1,
              );
              map.getSource('buses-service').setData({
                type: 'FeatureCollection',
                features: buses.map((coordinates) => ({
                  type: 'Feature',
                  properties: {},
                  geometry: {
                    type: 'Point',
                    coordinates,
                  },
                })),
              });
              this.setState({
                liveBusCount: buses.length,
              });
            };
            // this._liveBusesTimeout = setRafInterval(fetchBuses, 60 * 1000 + 1);
          });
        } else {
          const servicesTitle = services
            .map((s) => {
              const { name } = servicesData[s];
              return `${s}: ${name}`;
            })
            .join(', ');
          document.title = `Bus services; ${servicesTitle} - ${APP_NAME}`;

          let routeStops = [];
          let serviceGeometries = [];
          services.forEach((service) => {
            const { routes } = servicesData[service];
            const allRoutes = routes[0]
              .concat(routes[1] || [])
              .filter((el, pos, arr) => {
                return arr.indexOf(el) === pos;
              });
            routeStops = routeStops.concat(allRoutes);

            const routeGeometries = routesData[service];
            serviceGeometries = serviceGeometries.concat(
              routeGeometries.map((r) => ({
                service,
                geometry: toGeoJSON(r),
              })),
            );
          });

          // Merge and unique stops
          const intersectStops = [];
          routeStops = routeStops.filter((el, pos, arr) => {
            const unique = arr.indexOf(el) === pos;
            if (!unique && !intersectStops.includes(el))
              intersectStops.push(el);
            return unique;
          });
          this.setState({ intersectStops });

          // Fit map to route bounds
          const bounds = new mapboxgl.LngLatBounds();
          routeStops.forEach((stop) => {
            const { coordinates } = stopsData[stop];
            bounds.extend(coordinates);
          });
          map.fitBounds(bounds, {
            padding: BREAKPOINT()
              ? 80
              : {
                  top: 80,
                  right: 80,
                  bottom: 60 + 54 + 80, // height of search bar + float pill
                  left: 80,
                },
          });

          map.getSource('stops-highlight').setData({
            type: 'FeatureCollection',
            features: intersectStops.map((stop, i) => {
              const { name } = stopsData[stop];
              return {
                type: 'Feature',
                id: encode(stop),
                properties: {
                  name,
                  number: stop,
                },
                geometry: {
                  type: 'Point',
                  coordinates: stopsData[stop].coordinates,
                },
              };
            }),
          });

          // Show routes
          requestAnimationFrame(() => {
            map.getSource('routes-path').setData({
              type: 'FeatureCollection',
              features: serviceGeometries.map((sg) => ({
                type: 'Feature',
                id: encode(sg.service),
                properties: {
                  service: sg.service,
                },
                geometry: sg.geometry,
              })),
            });
            STORE.routesPathServices = serviceGeometries.map(
              (sg) => sg.service,
            );
          });
        }

        break;
      }
      case 'stop': {
        const stop = route.value;
        if (!stopsData[stop]) return;

        // Reset
        this.setState({
          expandSearch: false,
          shrinkSearch: true,
        });
        this._resetSearch();

        const { routes, name, coordinates } = stopsData[stop];
        if (route.subpage === 'routes') {
          document.title = `Routes passing Bus stop ${stop}: ${name} - ${APP_NAME}`;

          // Hide all stops
          map.setLayoutProperty('stops', 'visibility', 'none');
          map.setLayoutProperty('stops-icon', 'visibility', 'none');

          // Show the all stops in all routes
          const allStopsCoords = [];
          allStopsCoords.push(coordinates);
          const otherStops = new Set();
          routes.forEach((route) => {
            const [service, index] = route.split('-');
            const stops = servicesData[service].routes[index];
            stops.forEach((s) => stop !== s && otherStops.add(s));
          });
          [...otherStops].map((s) => {
            allStopsCoords.push(stopsData[s].coordinates);
          });

          // Fit map to route bounds
          const bounds = new mapboxgl.LngLatBounds();
          allStopsCoords.forEach((coordinates) => {
            bounds.extend(coordinates);
          });
          const bottom = this._floatPill
            ? this._floatPill.offsetHeight + 60 + 80
            : 80;
          map.fitBounds(bounds, {
            padding: BREAKPOINT()
              ? 80
              : {
                  top: 80,
                  right: 80,
                  bottom,
                  left: 80,
                },
          });

          map.getSource('stops-highlight').setData({
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                id: encode(stop),
                properties: {
                  name,
                  number: stop,
                  type: 'end',
                },
                geometry: {
                  type: 'Point',
                  coordinates,
                },
              },
            ],
          });

          // Show all routes
          requestAnimationFrame(() => {
            const serviceGeometries = routes.map((route) => {
              const [service, index] = route.split('-');
              const line = routesData[service][index];
              const geometry = toGeoJSON(line);
              return {
                service,
                geometry,
              };
            });

            map.getSource('routes-path').setData({
              type: 'FeatureCollection',
              features: serviceGeometries.map((sg, i) => ({
                type: 'Feature',
                id: encode(sg.service),
                properties: {
                  service: sg.service,
                },
                geometry: sg.geometry,
              })),
            });
            STORE.routesPathServices = serviceGeometries.map(
              (sg) => sg.service,
            );
          });
        } else {
          document.title = `Bus stop ${stop}: ${name} - ${APP_NAME}`;
          map.setLayoutProperty('stops', 'visibility', 'visible');
          map.setLayoutProperty('stops-icon', 'visibility', 'visible');
          this._showStopPopover(stop);
        }
        break;
      }
      case 'between': {
        const coords = route.value;
        const [startStopNumber, endStopNumber] = coords
          .split(/[,-]/)
          .map(String);
        if (!stopsData[startStopNumber] || !stopsData[endStopNumber]) {
          alert('One of the stop numbers are not found.');
          return;
        }

        document.title = `Routes between ${startStopNumber} and ${endStopNumber} - ${APP_NAME}`;
        // Reset
        this.setState({
          expandSearch: false,
          shrinkSearch: true,
        });

        // Hide all stops
        map.setLayoutProperty('stops', 'visibility', 'none');
        map.setLayoutProperty('stops-icon', 'visibility', 'none');

        function findRoutesBetween(startStop, endStop) {
          const results = [];

          const endServicesStops = endStop.routes.map((route) => {
            const [service, routeIndex] = route.split('-');
            let serviceStops = servicesData[service].routes[routeIndex];
            serviceStops = serviceStops.slice(
              0,
              serviceStops.indexOf(endStop.number) + 1,
            );
            return { service, stops: serviceStops, route };
          });

          startStop.routes.forEach((route) => {
            const [service, routeIndex] = route.split('-');
            let serviceStops = servicesData[service].routes[routeIndex];
            serviceStops = serviceStops.slice(
              serviceStops.indexOf(startStop.number),
            );

            // This service already can go straight to the end stop,
            // there's no need to find any connections from end stop
            if (serviceStops.includes(endStop.number)) {
              results.push({
                startService: service,
                startRoute: route,
                stopsBetween: [],
              });
            } else {
              endServicesStops.forEach(({ service: s, stops, route: r }) => {
                // console.log(serviceStops, stops);
                const intersectedStops = intersect(stops, serviceStops);
                if (intersectedStops.length) {
                  const startIndex = intersectedStops.indexOf(startStop.number);
                  if (startIndex > -1) intersectedStops.splice(startIndex, 1);
                  const endIndex = intersectedStops.indexOf(endStop.number);
                  if (endIndex > -1) intersectedStops.splice(endIndex, 1);

                  if (intersectedStops.length) {
                    results.push({
                      startStop,
                      startService: service,
                      startRoute: route,
                      stopsBetween: intersectedStops,
                      endRoute: r,
                      endService: s,
                      endStop,
                    });
                  }
                }
              });
            }
          });

          return results;
        }

        function findNearestStops(stop) {
          let distance = Infinity;
          let nearestStop = null;
          for (let i = 0, l = stopsDataArr.length; i < l; i++) {
            const s = stopsDataArr[i];
            if (s.number !== stop.number) {
              const d = getDistance(...stop.coordinates, ...s.coordinates);
              if (d < distance) {
                distance = d;
                nearestStop = s;
              }
            }
          }
          return nearestStop;
        }

        const startStop = stopsData[startStopNumber];
        const endStop = stopsData[endStopNumber];
        const nearestEndStop = findNearestStops(endStop);
        const nearestStartStop = findNearestStops(startStop);
        console.log(startStop, endStop, nearestEndStop, nearestStartStop);
        this._showBetweenPopover({
          startStop,
          endStop,
          nearestStartStop,
          nearestEndStop,
          startWalkMins: getWalkingMinutes(
            ruler.distance(
              startStop.coordinates,
              nearestStartStop.coordinates,
            ) * 1000,
          ),
          endWalkMins: getWalkingMinutes(
            ruler.distance(endStop.coordinates, nearestEndStop.coordinates) *
              1000,
          ),
          results: [
            findRoutesBetween(startStop, endStop),
            findRoutesBetween(startStop, nearestEndStop),
            findRoutesBetween(nearestStartStop, endStop),
            findRoutesBetween(nearestStartStop, nearestEndStop),
          ],
        });

        break;
      }
      default: {
        document.title = `${APP_NAME} - ${APP_LONG_NAME}`;

        // Show all stops
        map.setLayoutProperty('stops', 'visibility', 'visible');
        map.setLayoutProperty('stops-icon', 'visibility', 'visible');
      }
    }

    const { pathname, search, hash } = location;
    gtag('config', window._GA_TRACKING_ID, {
      page_path: pathname + search + hash,
    });

    this.setState({ routeLoading: false });
  };
  componentDidUpdate(_, prevState) {
    const { route } = this.state;
    if (route.path != prevState.route.path) {
      this._renderRoute();
    }
  }
  _setStartStop = (number) => {
    const { betweenEndStop } = this.state;
    if (betweenEndStop && betweenEndStop != number) {
      location.hash = `/between/${number}-${betweenEndStop}`;
    } else {
      this.setState({
        betweenStartStop: number,
        betweenEndStop: null,
      });
    }
  };
  _setEndStop = (number) => {
    const { betweenStartStop } = this.state;
    if (betweenStartStop && betweenStartStop != number) {
      location.hash = `/between/${betweenStartStop}-${number}`;
    } else {
      this.setState({
        betweenStartStop: null,
        betweenEndStop: number,
      });
    }
  };
  _resetStartEndStops = () => {
    this.setState({
      betweenStartStop: null,
      betweenEndStop: null,
    });
  };
  render(_, state) {
    const {
      route,
      routeLoading,
      stops,
      services,
      searching,
      expandSearch,
      expandedSearchOnce,
      servicesData,
      stopsData,
      shrinkSearch,
      showStopPopover,
      showBetweenPopover,
      showArrivalsPopover,
      intersectStops,
      showAd,
      liveBusCount,
    } = state;

    const popoverIsUp =
      !!showStopPopover || !!showBetweenPopover || !!showArrivalsPopover;
    const routeServices =
      route.page === 'service' && servicesData
        ? route.value.split('~').filter((s) => servicesData[s])
        : [];

    return (
      <div>
        <div
          id="search-popover"
          ref={(c) => (this._searchPopover = c)}
          class={`popover ${expandSearch ? 'expand' : ''} ${
            shrinkSearch ? 'shrink' : ''
          } ${routeLoading ? 'loading' : ''}`}
        >
          <div id="popover-float" hidden={!/service|stop/.test(route.page)}>
            {route.page === 'service' &&
            servicesData &&
            routeServices.length ? (
              <div class="float-pill" ref={(c) => (this._floatPill = c)}>
                <a
                  href="#/"
                  onClick={this._closeServicesPopover}
                  class="popover-close"
                >
                  &times;
                </a>
                {routeServices.length === 1 ? (
                  <div class="service-flex">
                    <span class="service-tag">{routeServices[0]}</span>
                    <div class="service-info">
                      <h1>{servicesData[routeServices[0]].name}</h1>
                      <p>
                        {servicesData[routeServices[0]].routes.length} route
                        {servicesData[routeServices[0]].routes.length > 1
                          ? 's'
                          : ''}{' '}
                        ∙&nbsp;
                        {servicesData[routeServices[0]].routes
                          .map(
                            (r) => `${r.length} stop${r.length > 1 ? 's' : ''}`,
                          )
                          .join(' ∙ ')}
                      </p>
                      {liveBusCount > 0 && (
                        <p style={{ marginTop: 5 }}>
                          <span class="live">LIVE</span>{' '}
                          <img src={busTinyImagePath} width="16" alt="" />{' '}
                          {liveBusCount} bus{liveBusCount === 1 ? '' : 'es'} now
                          on track.
                        </p>
                      )}
                    </div>
                  </div>
                ) : (
                  [
                    <div class="service-flex">
                      <div>
                        <h1>{routeServices.length} services selected</h1>
                        <p>
                          {intersectStops.length} intersecting stop
                          {intersectStops.length !== 1 && 's'}
                        </p>
                      </div>
                    </div>,
                    <div class="services-list">
                      {routeServices.sort(sortServices).map((service) => (
                        <a
                          href={`#/services/${service}`}
                          onClick={(e) => this._clickRoute(e, service)}
                          onMouseEnter={(e) => this._highlightRoute(e, service)}
                          onMouseLeave={this._unhighlightRoute}
                          class="service-tag"
                        >
                          {service}
                        </a>
                      ))}
                    </div>,
                  ]
                )}
              </div>
            ) : (
              route.page === 'stop' &&
              route.subpage === 'routes' &&
              stopsData && (
                <div class="float-pill" ref={(c) => (this._floatPill = c)}>
                  <a href="#/" class="popover-close">
                    &times;
                  </a>
                  <div class="service-flex">
                    <span class="stop-tag">{route.value}</span>
                    <div>
                      <h1>{stopsData[route.value].name}</h1>
                      <p>
                        {stopsData[route.value].services.length} passing routes
                      </p>
                    </div>
                  </div>
                  <div class="services-list" onClick={this._unhighlightRoute}>
                    {stopsData[route.value].services
                      .sort(sortServices)
                      .map((service) => (
                        <a
                          href={`#/services/${service}`}
                          onClick={(e) => this._clickRoute(e, service)}
                          onMouseEnter={(e) => this._highlightRoute(e, service)}
                          onMouseLeave={this._unhighlightRoute}
                          class="service-tag"
                        >
                          {service}
                        </a>
                      ))}
                  </div>
                </div>
              )
            )}
          </div>
          <div class="popover-inner">
            <div class="popover-search">
              <input
                type="search"
                placeholder="Search for bus service or stop"
                autocomplete="off"
                autocorrect="off"
                autocapitalize="off"
                spellcheck="false"
                ref={(c) => (this._searchField = c)}
                onfocus={this._handleSearchFocus}
                oninput={this._handleSearch}
                onkeydown={this._handleKeys}
                disabled={(!searching && !services.length) || popoverIsUp}
              />
              <button type="button" onclick={this._handleSearchClose}>
                Cancel
              </button>
            </div>
            <ul
              class={`popover-list ${
                services.length || searching ? '' : 'loading'
              } ${searching ? 'searching' : ''}`}
              ref={(c) => (this._servicesList = c)}
              onScroll={this._handleServicesScroll}
            >
              <li class="ads-li" hidden={!services.length || !showAd}>
                {services.length && showAd && <Ad key="ad" />}
              </li>
              {services.length
                ? (expandedSearchOnce ? services : services.slice(0, 10)).map(
                    (s) => (
                      <li key={s.number}>
                        <a
                          href={`#/services/${s.number}`}
                          class={
                            route.page === 'service' &&
                            route.value.split('~').includes(s.number)
                              ? 'current'
                              : ''
                          }
                          onMouseEnter={() => this._previewRoute(s.number)}
                          onMouseLeave={this._unpreviewRoute}
                        >
                          <b class="service-tag">{s.number}</b> {s.name}
                        </a>
                      </li>
                    ),
                  )
                : !searching &&
                  [1, 2, 3, 4, 5, 6, 7, 8].map((s, i) => (
                    <li key={s}>
                      <a href="#">
                        <b class="service-tag">&nbsp;&nbsp;&nbsp;</b>
                        <span class="placeholder">
                          █████{i % 3 == 0 ? '███' : ''} ███
                          {i % 2 == 0 ? '████' : ''}
                        </span>
                      </a>
                    </li>
                  ))}
              {searching &&
                !!stops.length &&
                stops.map((s) => (
                  <li key={s.number}>
                    <a href={`#/stops/${s.number}`}>
                      <b class="stop-tag">{s.number}</b> {s.name}
                    </a>
                  </li>
                ))}
              {searching && !stops.length && !services.length && (
                <li class="nada">No results.</li>
              )}
            </ul>
          </div>
        </div>
        <div
          id="between-popover"
          ref={(c) => (this._betweenPopover = c)}
          class={`popover ${showBetweenPopover ? 'expand' : ''}`}
        >
          {showBetweenPopover && [
            <a
              href="#/"
              onClick={this._resetStartEndStops}
              class="popover-close"
            >
              &times;
            </a>,
            <header>
              <h1>
                <small>Routes between</small>
                <br />
                <b class="stop-tag">
                  {showBetweenPopover.startStop.number}
                </b>{' '}
                and <b class="stop-tag">{showBetweenPopover.endStop.number}</b>
              </h1>
            </header>,
            <div class="popover-scroll">
              <div class="disclaimer">
                This is a beta feature. Directions and routes may not be
                correct.
              </div>
              <h2>Direct routes</h2>
              <BetweenRoutes
                results={showBetweenPopover.results[0]}
                onClickRoute={(e, result) =>
                  this._renderBetweenRoute({
                    e,
                    startStop: showBetweenPopover.startStop,
                    endStop: showBetweenPopover.endStop,
                    result,
                  })
                }
              />
              <h2>Alternative routes</h2>
              <h3>
                Nearby arrival stop: {showBetweenPopover.nearestEndStop.number}{' '}
                ({showBetweenPopover.endWalkMins}-min walk)
              </h3>
              <BetweenRoutes
                results={showBetweenPopover.results[1]}
                nearbyEnd={true}
                onClickRoute={(e, result) =>
                  this._renderBetweenRoute({
                    e,
                    startStop: showBetweenPopover.startStop,
                    endStop: showBetweenPopover.endStop,
                    result,
                  })
                }
              />
              <h3>
                Nearby departure stop:{' '}
                {showBetweenPopover.nearestStartStop.number} (
                {showBetweenPopover.startWalkMins}-min walk)
              </h3>
              <BetweenRoutes
                results={showBetweenPopover.results[2]}
                nearbyStart={true}
                onClickRoute={(e, result) =>
                  this._renderBetweenRoute({
                    e,
                    startStop: showBetweenPopover.startStop,
                    endStop: showBetweenPopover.endStop,
                    result,
                  })
                }
              />
              <h3>
                Nearby departure &amp; arrival stops:{' '}
                {showBetweenPopover.nearestStartStop.number} -{' '}
                {showBetweenPopover.nearestEndStop.number}
              </h3>
              <BetweenRoutes
                results={showBetweenPopover.results[3]}
                nearbyStart={true}
                nearbyEnd={true}
                onClickRoute={(e, result) =>
                  this._renderBetweenRoute({
                    e,
                    startStop: showBetweenPopover.startStop,
                    endStop: showBetweenPopover.endStop,
                    result,
                  })
                }
              />
            </div>,
          ]}
        </div>
        <div
          id="stop-popover"
          ref={(c) => (this._stopPopover = c)}
          class={`popover ${showStopPopover ? 'expand' : ''}`}
        >
          {showStopPopover && (
            <Fragment>
              <a
                href="#/"
                onClick={this._hideStopPopover}
                class="popover-close"
              >
                &times;
              </a>
              <header>
                <h1 onClick={this._zoomToStop}>
                  <b class="stop-tag">{showStopPopover.number}</b>{' '}
                  {showStopPopover.name}
                </h1>
              </header>
              <ScrollableContainer class="popover-scroll">
                <h2>
                  {showStopPopover.services.length} service
                  {showStopPopover.services.length == 1
                    ? ''
                    : 's'} &middot;{' '}
                  <a
                    href={`/bus-first-last/#${showStopPopover.number}`}
                    target="_blank"
                  >
                    First/last bus{' '}
                    <img
                      src={openNewWindowImagePath}
                      width="12"
                      height="12"
                      alt=""
                      class="new-window"
                    />
                  </a>
                </h2>
                <BusServicesArrival
                  map={route.page === 'stop' ? this.map : null}
                  id={showStopPopover.number}
                  services={showStopPopover.services}
                />
              </ScrollableContainer>
              <div class="popover-footer">
                <div class="popover-buttons alt-hide">
                  <a
                    href={`/bus-arrival/#${showStopPopover.number}`}
                    target="_blank"
                    onClick={this._openBusArrival}
                    class="popover-button"
                  >
                    Bus arrivals{' '}
                    <img
                      src={openNewWindowImagePath}
                      width="16"
                      height="16"
                      alt=""
                    />
                  </a>
                  {showStopPopover.services.length > 1 && (
                    <a
                      href={`#/stops/${showStopPopover.number}/routes`}
                      class="popover-button"
                    >
                      Passing routes{' '}
                      <img
                        src={passingRoutesImagePath}
                        width="16"
                        height="16"
                        alt=""
                      />
                    </a>
                  )}
                </div>
                <div class="popover-buttons alt-show-flex">
                  <button
                    onClick={() => this._setStartStop(showStopPopover.number)}
                    class="popover-button"
                  >
                    Set as Start
                  </button>
                  <button
                    onClick={() => this._setEndStop(showStopPopover.number)}
                    class="popover-button"
                  >
                    Set as End
                  </button>
                </div>
              </div>
            </Fragment>
          )}
        </div>
        <div
          id="arrivals-popover"
          class={`popover ${showArrivalsPopover ? 'expand' : ''}`}
        >
          {showArrivalsPopover && [
            <a href="#/" onClick={this._closeBusArrival} class="popover-close">
              &times;
            </a>,
            <a
              href={`/bus-arrival/#${showArrivalsPopover.number}`}
              target="_blank"
              onClick={(e) => {
                this._openBusArrival(e, true);
                this._closeBusArrival(e);
              }}
              class="popover-popout popover-close"
            >
              Pop out{' '}
              <img src={openNewWindowImagePath} width="16" height="16" alt="" />
            </a>,
            <div class="popover-scroll">
              <iframe src={showArrivalsPopover.webviewURL}></iframe>
            </div>,
          ]}
        </div>
      </div>
    );
  }
}

render(<App />, document.getElementById('app'));

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    const debug = /debug/.test(location.hash);
    if (debug) {
      navigator.serviceWorker.register('../service-worker.js?debug');
    } else {
      navigator.serviceWorker.register('../service-worker.js');
    }
  });
}

if (
  matchMedia('(display-mode: standalone)').matches ||
  'standalone' in navigator
) {
  gtag('event', 'pwa_load', {
    event_category: 'PWA',
    event_label: 'standalone',
    value: true,
    non_interaction: true,
  });
}

if (window.navigator.standalone) {
  document.body.classList.add('standalone');

  // Refresh map size when dimissing software keyboard
  // https://stackoverflow.com/a/19464029/20838
  document.addEventListener('focusout', () => {
    if (_map) _map.resize();
  });

  // Enable CSS active states
  document.addEventListener('touchstart', () => {}, false);
}

const isSafari = navigator.vendor && navigator.vendor.indexOf('Apple') !== -1;
if (isSafari && !window.navigator.standalone) {
  setTimeout(function () {
    const ratio = window.devicePixelRatio;
    const canvas = document.createElement('canvas');
    const w = (canvas.width = window.screen.width * ratio);
    const h = (canvas.height = window.screen.height * ratio);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#F9F5ED';
    ctx.fillRect(0, 0, w, h);
    const icon = new Image();
    icon.onload = () => {
      const aspectRatio = icon.width / icon.height;
      icon.width = w / 2;
      icon.height = w / 2 / aspectRatio;
      ctx.drawImage(
        icon,
        (w - icon.width) / 2,
        (h - icon.height) / 2,
        icon.width,
        icon.height,
      );
      document.head.insertAdjacentHTML(
        'beforeend',
        `<link rel="apple-touch-startup-image" href="${canvas.toDataURL()}">`,
      );
    };
    icon.src = iconSVGPath;
  }, 5000);
}
