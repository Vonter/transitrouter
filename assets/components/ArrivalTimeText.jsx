import { h } from 'preact';
import { useTranslation } from 'react-i18next';

export default function ArrivalTimeText({ ms }) {
  const { t } = useTranslation();
  if (ms === null) return;
  const totalMinutes = Math.floor(ms / 1000 / 60);
  if (totalMinutes <= 0) {
    return t('glossary.arriving');
  }
  
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
