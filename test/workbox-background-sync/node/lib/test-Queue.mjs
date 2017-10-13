/*
 Copyright 2017 Google Inc. All Rights Reserved.
 Licensed under the Apache License, Version 2.0 (the "License");
 you may not use this file except in compliance with the License.
 You may obtain a copy of the License at

     http://www.apache.org/licenses/LICENSE-2.0

 Unless required by applicable law or agreed to in writing, software
 distributed under the License is distributed on an "AS IS" BASIS,
 WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 See the License for the specific language governing permissions and
 limitations under the License.
*/

import {expect} from 'chai';
import clearRequire from 'clear-require';
import sinon from 'sinon';
import expectError from '../../../../infra/testing/expectError';
import {OBJECT_STORE_NAME} from
    '../../../../packages/workbox-background-sync/lib/constants.mjs';
import QueueStore from
    '../../../../packages/workbox-background-sync/lib/QueueStore.mjs';
import {resetEventListeners} from
    '../../../../infra/testing/sw-env-mocks/event-listeners.js';


let Queue;

const clearObjectStore = async () => {
  // Get a reference to the DB by invoking _getDb on a mock instance.
  const db = await QueueStore.prototype._getDb.call({});

  await new Promise((resolve, reject) => {
    const txn = db.transaction(OBJECT_STORE_NAME, 'readwrite');
    txn.onerror = () => reject(txn.error);
    txn.oncomplete = () => resolve();
    txn.objectStore(OBJECT_STORE_NAME).clear();
  });
};

const getObjectStoreEntries = async () => {
  // Get a reference to the DB by invoking _getDb on a mock instance.
  const db = await QueueStore.prototype._getDb.call({});

  const entries = await new Promise((resolve, reject) => {
    const entries = [];
    const txn = db.transaction(OBJECT_STORE_NAME, 'readwrite');
    txn.onerror = () => reject(txn.error);
    txn.objectStore(OBJECT_STORE_NAME).openCursor().onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        entries.push({key: cursor.key, value: cursor.value});
        cursor.continue();
      } else {
        resolve(entries);
      }
    };
  });
  return entries;
};

describe(`[workbox-background-sync] Queue`, function() {
  const sandbox = sinon.sandbox.create();

  beforeEach(async function() {
    sandbox.restore();

    // Clear Queue so the name map gets reset on re-import.
    clearRequire.match(RegExp('workbox-background-sync/lib/Queue.mjs'));

    clearObjectStore();

    // Remove any lingering event listeners
    resetEventListeners();

    // Re-import Queue each time so the name map gets reset.
    const imprt = await import(
        '../../../../packages/workbox-background-sync/lib/Queue.mjs');

    Queue = imprt.default;
  });

  after(async function() {
    sandbox.restore();

    // Clear Queue so the name map gets reset on re-import.
    clearRequire.match(RegExp('workbox-background-sync/lib/Queue.mjs'));

    clearObjectStore();

    // Remove any lingering event listeners
    resetEventListeners();
  });

  describe(`constructor`, function() {
    it(`should throw if two queues are created with the same name`,
        async function() {
      expect(() => {
        new Queue('foo');
        new Queue('bar');
      }).not.to.throw();

      await expectError(() => {
        new Queue('foo');
      }, 'duplicate-queue-name');

      expect(() => {
        new Queue('baz');
      }).not.to.throw();
    });

    it(`should add a sync event listener that replays the queue when the ` +
        `event is dispatched`, async function() {
      sandbox.spy(self, 'addEventListener');
      sandbox.stub(Queue.prototype, 'replayRequests');

      new Queue('foo');

      expect(self.addEventListener.calledOnce).to.be.true;
      expect(self.addEventListener.calledWith('sync')).to.be.true;

      self.dispatchEvent(new SyncEvent('sync', {
        tag: 'workbox-background-sync:foo',
      }));

      expect(Queue.prototype.replayRequests.calledOnce).to.be.true;
    });

    it(`should try to replay the queue on SW startup in browsers that ` +
        `don't support the sync event`, async function() {
      // Delete the SyncManager interface to mock a non-supporting browser.
      const originalSyncManager = registration.sync;
      delete registration.sync;

      sandbox.stub(Queue.prototype, 'replayRequests');

      new Queue('foo');

      expect(Queue.prototype.replayRequests.calledOnce).to.be.true;

      registration.sync = originalSyncManager;
    });
  });

  describe(`createPlugin`, function() {
    it(`should return an object implementing the fetchDidFail plugin ` +
        `method that adds the failed request to the queue`, async function() {
      sandbox.stub(Queue.prototype, 'addRequest');
      const queue = new Queue('foo');
      const plugin = queue.createPlugin();

      plugin.fetchDidFail({request: new Request('/')});
      expect(Queue.prototype.addRequest.calledOnce).to.be.true;
      expect(Queue.prototype.addRequest.calledWith(
          sinon.match.instanceOf(Request))).to.be.true;
    });
  });

  describe(`addRequest`, function() {
    it(`should serialize the request and store it in IndexedDB`,
        async function() {
      const now = Date.now();
      const queue = new Queue('foo');
      const requestUrl = 'https://example.com';
      const requestInit = {
        method: 'POST',
        body: 'testing...',
        headers: {'x-foo': 'bar'},
        mode: 'cors',
      };
      const request = new Request(requestUrl, requestInit);

      await queue.addRequest(request);

      const entries = await getObjectStoreEntries();
      expect(entries).to.have.lengthOf(1);
      expect(entries[0].value.storableRequest.url).to.equal(requestUrl);
      expect(entries[0].value.storableRequest.timestamp).to.be.at.least(now);
      expect(entries[0].value.storableRequest.requestInit).to.have.keys([
        'method',
        'body',
        'headers',
        'mode',
      ]);
    });

    it(`should register to receive sync events for a unique tag`,
        async function() {
      sandbox.stub(self.registration, 'sync').value({
        register: sinon.stub().resolves(),
      });

      const queue = new Queue('foo');
      const requestUrl = 'https://example.com';
      const requestInit = {
        method: 'POST',
        body: 'testing...',
        headers: {'x-foo': 'bar'},
        mode: 'cors',
      };
      const request = new Request(requestUrl, requestInit);

      await queue.addRequest(request);

      expect(self.registration.sync.register.calledOnce).to.be.true;
      expect(self.registration.sync.register.calledWith(
          'workbox-background-sync:foo')).to.be.true;
    });

    it(`should invoke the requestWillEnqueue callback`, async function() {
      const queue = new Queue('foo', {
        callbacks: {
          requestWillEnqueue: (storableRequest) => {
            storableRequest.url += '?q=foo';
          },
        },
      });

      const request = new Request('/');
      await queue.addRequest(request);

      const entries = await getObjectStoreEntries();
      expect(entries).to.have.lengthOf(1);
      expect(entries[0].value.storableRequest.url).to.equal('/?q=foo');
    });

    it(`should support modifying the stored request via requestWillEnqueue`,
        async function() {
      const requestWillEnqueue = sinon.spy();
      const queue = new Queue('foo', {
        callbacks: {requestWillEnqueue},
      });

      const request = new Request('/');
      await queue.addRequest(request);

      expect(requestWillEnqueue.calledOnce).to.be.true;
      expect(requestWillEnqueue.calledWith(sinon.match({
        url: '/',
        timestamp: sinon.match.number,
        requestInit: sinon.match.object,
      }))).to.be.true;
    });
  });

  describe(`replayRequests`, function() {
    it(`should try to re-fetch all requests in the queue`, async function() {
      sandbox.spy(self, 'fetch');

      const queue1 = new Queue('foo');
      const queue2 = new Queue('bar');

      // Add requests for both queues to ensure only the requests from
      // the matching queue are replayed.
      await queue1.addRequest(new Request('/one'));
      await queue2.addRequest(new Request('/two'));
      await queue1.addRequest(new Request('/three'));
      await queue2.addRequest(new Request('/four'));
      await queue1.addRequest(new Request('/five'));

      await queue1.replayRequests();

      expect(self.fetch.callCount).to.equal(3);

      expect(self.fetch.getCall(0).calledWith(sinon.match({
        url: '/one',
      }))).to.be.true;

      expect(self.fetch.getCall(1).calledWith(sinon.match({
        url: '/three',
      }))).to.be.true;

      expect(self.fetch.getCall(2).calledWith(sinon.match({
        url: '/five',
      }))).to.be.true;

      await queue2.replayRequests();
      expect(self.fetch.callCount).to.equal(5);

      expect(self.fetch.getCall(3).calledWith(sinon.match({
        url: '/two',
      }))).to.be.true;

      expect(self.fetch.getCall(4).calledWith(sinon.match({
        url: '/four',
      }))).to.be.true;
    });

    it(`should remove requests after a successful retry`, async function() {
      sandbox.spy(self, 'fetch');

      const queue1 = new Queue('foo');
      const queue2 = new Queue('bar');

      // Add requests for both queues to ensure only the requests from
      // the matching queue are replayed.
      await queue1.addRequest(new Request('/one'));
      await queue2.addRequest(new Request('/two'));
      await queue1.addRequest(new Request('/three'));
      await queue2.addRequest(new Request('/four'));
      await queue1.addRequest(new Request('/five'));

      await queue1.replayRequests();
      expect(self.fetch.callCount).to.equal(3);

      const entries = await getObjectStoreEntries();
      expect(entries.length).to.equal(2);
      expect(entries[0].value.storableRequest.url).to.equal('/two');
      expect(entries[1].value.storableRequest.url).to.equal('/four');
    });

    it(`should ignore (and remove) requests if maxRetentionTime has passed`,
        async function() {
      sandbox.spy(self, 'fetch');
      const clock = sandbox.useFakeTimers({
        now: Date.now(),
        toFake: ['Date'],
      });

      const queue = new Queue('foo', {
        maxRetentionTime: 1000,
      });

      await queue.addRequest(new Request('/one'));
      await queue.addRequest(new Request('/two'));

      clock.tick(2000);

      await queue.addRequest(new Request('/three'));
      await queue.replayRequests();

      expect(self.fetch.calledOnce).to.be.true;
      expect(self.fetch.calledWith(sinon.match({
        url: '/three',
      }))).to.be.true;

      const entries = await getObjectStoreEntries();
      // Assert that the two requests not replayed were deleted.
      expect(entries.length).to.equal(0);
    });

    it(`should keep a request in the queue if re-fetching fails`,
        async function() {
      sandbox.stub(self, 'fetch')
          .onCall(1).rejects(new Error())
          .onCall(3).rejects(new Error())
          .callThrough();

      const queue = new Queue('foo');

      await queue.addRequest(new Request('/one'));
      await queue.addRequest(new Request('/two'));
      await queue.addRequest(new Request('/three'));
      await queue.addRequest(new Request('/four'));
      await queue.addRequest(new Request('/five'));
      await queue.replayRequests(); // The 2nd and 4th requests should fail.


      const entries = await getObjectStoreEntries();
      expect(entries.length).to.equal(2);
      expect(entries[0].value.storableRequest.url).to.equal('/two');
      expect(entries[1].value.storableRequest.url).to.equal('/four');
    });

    it(`should re-register for a sync event if re-fetching fails`,
        async function() {
      sandbox.stub(self.registration, 'sync').value({
        register: sinon.stub().resolves(),
      });
      sandbox.stub(self, 'fetch')
          .onCall(1).rejects(new Error())
          .callThrough();

      const queue = new Queue('foo');

      // Add requests for both queues to ensure only the requests from
      // the matching queue are replayed.
      await queue.addRequest(new Request('/one'));
      await queue.addRequest(new Request('/two'));

      self.registration.sync.register.reset();
      await queue.replayRequests(); // The second request should fail.

      expect(self.registration.sync.register.calledOnce).to.be.true;
      expect(self.registration.sync.register.calledWith(
          'workbox-background-sync:foo')).to.be.true;
    });

    it(`should invoke all replay callbacks`, async function() {
      const requestWillReplay = sinon.spy();
      const queueDidReplay = sinon.spy();

      const queue = new Queue('foo', {
        callbacks: {
          requestWillReplay,
          queueDidReplay,
        },
      });

      await queue.addRequest(new Request('/one'));
      await queue.addRequest(new Request('/two'));
      await queue.replayRequests();

      expect(requestWillReplay.calledTwice).to.be.true;
      expect(requestWillReplay.getCall(0).calledWith(sinon.match({
        url: '/one',
        timestamp: sinon.match.number,
        requestInit: sinon.match.object,
      }))).to.be.true;
      expect(requestWillReplay.getCall(1).calledWith(sinon.match({
        url: '/two',
        timestamp: sinon.match.number,
        requestInit: sinon.match.object,
      }))).to.be.true;

      expect(queueDidReplay.calledOnce).to.be.true;
      expect(queueDidReplay.calledWith(sinon.match([
        sinon.match({
          request: sinon.match.instanceOf(Request).and(
              sinon.match({url: '/one'})),
          response: sinon.match.instanceOf(Response),
        }),
        sinon.match({
          request: sinon.match.instanceOf(Request).and(
              sinon.match({url: '/two'})),
          response: sinon.match.instanceOf(Response),
        }),
      ]))).to.be.true;

      requestWillReplay.reset();
      queueDidReplay.reset();

      sandbox.stub(self, 'fetch')
          .onCall(1).rejects(new Error())
          .callThrough();

      await queue.addRequest(new Request('/three'));
      await queue.addRequest(new Request('/four'));
      await queue.replayRequests();

      expect(requestWillReplay.calledTwice).to.be.true;

      expect(queueDidReplay.calledOnce).to.be.true;
      expect(queueDidReplay.calledWith(sinon.match([
        sinon.match({
          request: sinon.match.instanceOf(Request).and(
              sinon.match({url: '/three'})),
          response: sinon.match.instanceOf(Response),
        }),
        sinon.match({
          request: sinon.match.instanceOf(Request).and(
              sinon.match({url: '/four'})),
          error: sinon.match.instanceOf(Error),
        }),
      ]))).to.be.true;
    });

    it(`should support modifying the request via the requestWillReplay`,
        async function() {
      sandbox.spy(self, 'fetch');

      const requestWillReplay = (storableRequest) => {
        storableRequest.url += '?q=foo';
      };

      const queue = new Queue('foo', {
        callbacks: {requestWillReplay},
      });

      await queue.addRequest(new Request('/one'));
      await queue.addRequest(new Request('/two'));
      await queue.replayRequests();

      expect(self.fetch.calledTwice).to.be.true;
      expect(self.fetch.getCall(0).calledWith(sinon.match({
        url: '/one?q=foo',
      }))).to.be.true;
      expect(self.fetch.getCall(1).calledWith(sinon.match({
        url: '/two?q=foo',
      }))).to.be.true;
    });
  });
});
