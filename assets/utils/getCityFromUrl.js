// Get city code from URL path
export default () => {
  const path = location.hash.replace(/^#/, '') || '/';
  const cityMatch = path.match(/^\/([A-Z]{3})(\/|$)/);
  return cityMatch ? cityMatch[1] : null;
};
