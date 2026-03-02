import { h } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import maplibregl from 'maplibre-gl';
import { getCityBounds } from '../config';

export default function MapPicker({ stopsData, onStopSelect }) {
  const mapContainerRef = useRef(null);

  useEffect(() => {
    if (!mapContainerRef.current) return;

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: '/data/style.json',
      bounds: getCityBounds(),
      fitBoundsOptions: { padding: 40 },
      renderWorldCopies: false,
      attributionControl: false,
      boxZoom: false,
      pitchWithRotate: false,
      dragRotate: false,
      touchPitch: false,
    });

    map.addControl(
      new maplibregl.AttributionControl({ compact: true }),
      'bottom-right',
    );
    map.addControl(
      new maplibregl.NavigationControl({ showCompass: false }),
      'bottom-right',
    );

    map.on('load', () => {
      const features = Object.entries(stopsData).map(([stopId, stop]) => ({
        type: 'Feature',
        properties: { id: stopId, name: stop[2] || '' },
        geometry: { type: 'Point', coordinates: [stop[0], stop[1]] },
      }));

      map.addSource('stops', {
        type: 'geojson',
        tolerance: 10,
        buffer: 0,
        data: { type: 'FeatureCollection', features },
      });

      map.addLayer({
        id: 'stops',
        type: 'circle',
        source: 'stops',
        paint: {
          'circle-radius': [
            'interpolate',
            ['linear'],
            ['zoom'],
            10,
            3,
            14,
            6,
            16,
            8,
          ],
          'circle-color': '#E4324B',
          'circle-stroke-color': '#fff',
          'circle-stroke-width': 1.5,
        },
      });

      map.on('click', 'stops', (e) => {
        if (e.features.length) onStopSelect(e.features[0].properties.id);
      });

      map.on('mouseenter', 'stops', () => {
        map.getCanvas().style.cursor = 'pointer';
      });

      map.on('mouseleave', 'stops', () => {
        map.getCanvas().style.cursor = '';
      });
    });

    return () => map.remove();
  }, []);

  return (
    <div class="map-picker">
      <div class="map-picker-hint">Click a stop to view its route diagram</div>
      <div ref={mapContainerRef} class="map-picker-map" />
    </div>
  );
}
