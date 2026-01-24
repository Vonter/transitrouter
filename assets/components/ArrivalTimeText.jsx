import { h } from 'preact';

export default function ArrivalTimeText({ ms }) {
  if (ms === null) return;
  const totalMinutes = Math.floor(ms / 1000 / 60);
  
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  
  if (hours > 0 && minutes > 0) {
    return `${hours}h${minutes}m`;
  } else if (hours > 0) {
    return `${hours}h`;
  } else {
    return `${minutes}m`;
  }
}
