const { EventEmitter } = require('events');

function createStreamEventBus() {
  const ee = new EventEmitter();
  ee.setMaxListeners(0);
  return {
    on: (event: any, cb: any) => { ee.on(event, cb); return () => ee.off(event, cb); },
    emit: (event: any, payload: any) => ee.emit(event, payload),
    emitAny: (payload: any) => ee.emit('any', payload),
    onAny: (cb: any) => { ee.on('any', cb); return () => ee.off('any', cb); },
  };
}

module.exports = { createStreamEventBus };
