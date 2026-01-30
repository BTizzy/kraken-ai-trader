const PriceDataCollector = require('../lib/price_data_collector');
(async function(){
  const c = new PriceDataCollector({useWebSocket:false, collectionInterval:1000});
  console.log('Collector created. Initial status:', c.status());
  c.startCollection();
  setTimeout(()=>{
    console.log('Status after start:', c.status());
    c.stop();
  }, 3000);
})();
