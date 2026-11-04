'use strict';

// Valores por defecto y carga de config.json (sobrescribe los valores por defecto).

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  camera: { did: '', password: '', deviceType: '184', userId: 0 },
  bridge: { host: '127.0.0.1', port: 8766 },
  dashboard: { host: '127.0.0.1', port: 8080 },
};

function load(file = path.join(__dirname, 'config.json')) {
  const user = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  return {
    camera: { ...DEFAULTS.camera, ...(user.camera || {}) },
    bridge: { ...DEFAULTS.bridge, ...(user.bridge || {}) },
    dashboard: { ...DEFAULTS.dashboard, ...(user.dashboard || {}) },
  };
}

module.exports = { DEFAULTS, load };
