const fs = require('fs');
const type = (filename) => {
  if (/\.css$/.test(filename)) return 'style';
  if (/\.js$/.test(filename)) return 'script';
  if (/\.(jpe?g|png|gif|svg)$/.test(filename)) return 'image';
  if (/\.json$/.test(filename)) return 'document';
};

const files = fs.readdirSync('dist');

const headers = [
  {
    path: '/',
    files: [/^app\..+js$/, /^app\..+css$/],
  },
  {
    path: '/arrival/',
    files: [
      /^arrival\..+js$/,
      /^arrival\..+css$/,
      /^stop\-active\..+svg$/,
      /^bus\-bendy\..+svg$/,
      /^bus\-double\..+svg$/,
      /^bus\-single\..+svg$/,
      /^wheelchair\..+svg$/,
    ],
  },
  {
    path: '/beta/first-last/',
    files: [/^firstlast\..+js$/, /^firstlast\..+css$/],
  },
  {
    path: '/diagram/',
    files: [/^diagram\..+js$/, /^diagram\..+css$/],
  },
  {
    path: '/beta/visualization/',
    files: [/^visualization\..+js$/],
  },
  {
    path: '/data/',
    files: [/^stops\..+json$/, /^routes\..+json$/, /^services\..+json$/],
  },
];

let content = '';
headers.forEach((h) => {
  const links = files
    .filter((f) => h.files.some((r) => r.test(f)))
    .map((f) => `  Link: </${f}>; rel=preload; as=${type(f)}\n`)
    .join('');
  if (links) {
    content += h.path + '\n' + links;
  }
});

// Headers for assets, 1 month, 1 week
content += `
/*.css
  Cache-Control: public, max-age=2592000
/*.js
  Cache-Control: public, max-age=2592000
/*.svg
  Cache-Control: public, max-age=2592000
/*.png
  Cache-Control: public, max-age=2592000
/*.jpg
  Cache-Control: public, max-age=2592000

/*.geojson
  Cache-Control: public, max-age=604800

/*.json
  Content-Type: application/json
  Cache-Control: public, max-age=604800`;

fs.writeFileSync('dist/_headers', content);
