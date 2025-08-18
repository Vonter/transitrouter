export const encode = (id) =>
  parseInt(
    String(id).replace(/\w/gi, (c) => '' + c.charCodeAt()),
    10,
  );

export const decode = (number) =>
  String.fromCharCode(...('' + number).match(/\w\w/gi));
