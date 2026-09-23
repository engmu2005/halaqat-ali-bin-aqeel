'use strict';

/** نقطة إقلاع الخادم — npm start */
const { config, assertConfig } = require('./config');

assertConfig();

const { createApp } = require('./app');

const app = createApp();
app.listen(config.port, '0.0.0.0', () => {
  console.log(`✔ خادم حلقات علي بن عقيل يعمل على المنفذ ${config.port} (${config.env})`);
});
