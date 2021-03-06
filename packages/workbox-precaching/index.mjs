/*
  Copyright 2017 Google Inc.

  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

      https://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
*/

import core from 'workbox-core';
import PrecacheController from './controllers/PrecacheController.mjs';
import defaultPrecachingExport from './default-precaching-export.mjs';
import './_version.mjs';
/**
 * @module workbox-precaching
 */

if (process.env.NODE_ENV !== 'production') {
  core.assert.isSwEnv('workbox-precaching');
}

export {
  PrecacheController,
};

export default defaultPrecachingExport;
