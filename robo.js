const { random } = require('lodash');
const _ = require('lodash');
const logUpdate = require('log-update');
const API = require('kucoin-node-sdk');
const readline = require('readline');
const fs = require('fs');
const logger = require('./loggerV2.js');


Number.prototype.padLeft = function (len, chr){
  var self = Math.abs(this)+'';
  return (this<0 && '-' || '')+
          (String(Math.pow( 10, (len || 2)-self.length))
            .slice(1).replace(/0/g,chr||'0') + self);
}

String.prototype.padRight = function (n, str) {
  return this+Array(n-this.length+1).join(str||' ');
}

String.prototype.padLeft = function (n, str) {
  return Array(n-this.length+1).join(str||' ')+this;
}

Date.prototype.toDateTimeString = function() {
  return this.getUTCFullYear() +
    '-' + (this.getUTCMonth() + 1).padLeft(2) +
    '-' + (this.getUTCDate()).padLeft(2) +
    ' ' + (this.getUTCHours()).padLeft(2) +
    ':' + (this.getUTCMinutes()).padLeft(2) +
    ':' + (this.getUTCSeconds()).padLeft(2) +
    '.' + (this.getUTCMilliseconds() / 1000).toFixed(3).slice(2, 5) +
    'Z';
};

Date.prototype.to_dt_string = function() {
  return this.getUTCFullYear().toString().substring(2, 4) +
         (this.getUTCMonth() + 1).padLeft(2) +
         (this.getUTCDate()).padLeft(2)
};

Date.prototype.to_hr_string = function() {
  return (this.getUTCHours()).padLeft(2);
};



class BandControl {
  constructor(bandQtt, initBalance, basePrice, targetProfit) {
    this.bands = []
    this.bandQtt = bandQtt
    this.initBalance = initBalance
    this.basePrice = basePrice
    this.targetProfit = targetProfit
    this.lastActiveBand = null

    this.bands.push(new OperationBand(0, this.basePrice, this.targetProfit))

    if (bandQtt > 2) {
      this.addHigherBand()
    }

    let limit = bandQtt - this.bands.length

    for (let i = 0; i < limit; i++) {
      this.addLowerBand()
    }

    this.distributeEqually(initBalance)
  }

  getTopBand() {
    return this.bands[0]
  }

  getBottomBand() {
    return this.bands[this.bands.length - 1]
  }

  getPreviousBand(band) {
    return this.findBandByBandNumber(band.bandNumber - 1)
  }

  getNextBand(band) {
    return this.findBandByBandNumber(band.bandNumber + 1)
  }

  addHigherBand() {
    let topBand = this.getTopBand()
    let newBand = new OperationBand(topBand.bandNumber + 1, this.basePrice, this.targetProfit)

    this.bands.unshift(newBand)

    return newBand
  }

  addLowerBand() {
    let bottomBand = this.getBottomBand()
    let newBand = new OperationBand(bottomBand.bandNumber - 1, this.basePrice, this.targetProfit)

    this.bands.push(newBand)

    return newBand
  }

  distributeEqually(value) {
    value = parseFloat(value)

    let share = value / this.bands.length

    this.bands.forEach((item, i) => {
      item.availableBalance += share

      if (item.initBalance == null) {
        item.initBalance = item.availableBalance
      }

    })
  }

  findBandByPrice(price) {
    if (typeof price == 'undefined') {return false}
    price = parseFloat(price)

    const found = this.bands.find(item => item.isPriceBetween(price));

    if (typeof found != 'undefined') {
      return found
    }

    let band = false
    if (price > this.getTopBand().ceilingPrice) {
      while (price > this.getTopBand().ceilingPrice) {
        band = this.addHigherBand()
      }
      this.addHigherBand() //sempre que criar uma banda superior, já cria uma a mais para deixar um saldo reservado
      return band
    } else {
      while (price <= this.getBottomBand().floorPrice) {
        band = this.addLowerBand()
      }
      return band
    }
  }

  findBandByBuyTransactionId(buyTransactionId) {
    for (let i = this.bands.length - 1; i >= 0; i--) {
      let band = this.bands[i]

      if (band.assets.findIndex(item => item.id == buyTransactionId) >= 0) {
        return band
      }
    }
    return null
  }

  findBandByBandNumber(bandNumber) {
    return this.bands.find(item => item.bandNumber == bandNumber)
  }

  registerBuyTransaction(transaction) {
    logAdd(`BandControl: entering registerBuyTransaction | Transaction Info > id: ${transaction.id} | price: ${transaction.price} | value: ${transaction.value} | size: ${transaction.size} | fee: ${transaction.fee}`)

    let band = this.findBandByPrice(transaction.price)

    logAdd(`BandControl: before band.registerBuyTransaction | bandInfo > ${band.toString()}`)

    band.registerBuyTransaction(transaction)

    logAdd(`BandControl: after  band.registerBuyTransaction | bandInfo > ${band.toString()}`)
  }

  registerSellTransaction(transaction) {
    logAdd(`BandControl: entering registerSellTransaction | Transaction Info > id: ${transaction.id} | price: ${transaction.price} | value: ${transaction.value} | size: ${transaction.size} | fee: ${transaction.fee}`)

    let band = this.findBandByBuyTransactionId(transaction.buyId)

    logAdd(`BandControl: before band.registerSellTransaction | bandInfo > ${band.toString()}`)

    band.registerSellTransaction(transaction)

    logAdd(`BandControl: after  band.registerSellTransaction | bandInfo > ${band.toString()}`)
  }

  sellingAt() {
    //Lopping reverso
    for (let i = this.bands.length - 1; i >= 0; i--) {
      let band = this.bands[i]

      if (band.assets.length > 0) {
        return band.sellingAt()
      }
    }

    return Number.POSITIVE_INFINITY
  }

  dumpingAt() {
    this.bands.forEach((band, i) => {
      if (band.dumpingAt() > 0) {
        return band.dumpingAt()
      }
    })
    return 0
  }

  getCheapestAsset() {
    for (let i = this.bands.length - 1; i >= 0; i--) {
      let band = this.bands[i]

      if (band.assets.length > 0) {
        return band.assets[0]
      }
    }
    return null
  }

  activateBand(band) {
    if (band.bandNumber == this.lastActiveBand) {return}

    logAdd('Trocando banda ativa. Banda anterior ' + this.lastActiveBand + ' nova banda ' + band.bandNumber)

    var higherBand = band.bandNumber + 1
    var lowerBand  = band.bandNumber - (this.bandQtt - 2)

    logAdd('Bandas a serem ativadas:' + lowerBand + ' a ' + higherBand)

    //Sacando o saldo das bandas desativadas
    var withdraw = 0
    var activeBands = []
    this.bands.forEach((bandAux, i) => {
      logAdd('Sacando banda: ' + bandAux.bandNumber + ', ' + bandAux.availableBalance)
      withdraw += bandAux.availableBalance
      this.bands[i].availableBalance = 0

      if (bandAux.bandNumber >= lowerBand && bandAux.bandNumber <= higherBand) {
        activeBands.push(bandAux.bandNumber)
      }
    })

    // console.log(activeBands)
    // console.log(activeBands.length)
    // process.exit(0)

    //Distribuindo o saldo das que ficaram ativas
    var newValue = (withdraw / activeBands.length)
    logAdd('Total a distribuir: ' + withdraw + ', parcela de ' + newValue + ' para cada uma das bandas')
    this.bands.forEach((bandAux, i) => {
      if (activeBands.includes(bandAux.bandNumber)) {
        let antes = this.bands[i].availableBalance

        this.bands[i].availableBalance += newValue

        logAdd('Somou: ' + newValue + ' na ' + bandAux.bandNumber + '. Tinha ' + antes + ', ficou com ' + this.bands[i].availableBalance)
      }
    })

    // process.exit(1)

    this.lastActiveBand = band.bandNumber
  }

  getStats() {
    let ret = {
      availableBalance: 0,
      counterBalance: 0,
      totalBalance: 0,
      usedBalance:0,
      assetCount: 0,
      profits: 0,
      losses: 0,
      fees: 0,
    }

    this.bands.forEach((bandAux, i) => {
      ret.availableBalance += bandAux.availableBalance
      ret.counterBalance   += bandAux.counterBalance
      ret.totalBalance     += bandAux.totalBalance()
      ret.usedBalance      += bandAux.usedBalance()
      ret.assetCount       += bandAux.assets.length
      ret.profits          += bandAux.results.profits
      ret.losses           += bandAux.results.losses
      ret.fees             += bandAux.results.fees
    })

    return ret
  }
}

class OperationBand {
  constructor(bandNumber, basePrice, targetProfit) {
    basePrice = parseFloat(basePrice)
    this.bandNumber = bandNumber;
    this.basePrice = basePrice;
    this.results = {
      profits: 0.0,
      losses: 0.0,
      fees: 0.0
    }
    this.initBalance = null;
    this.availableBalance = 0;
    this.counterBalance = 0;
    this.ceilingPrice = 0;
    this.floorPrice = 0;
    this.assets = []

    let band0FloorPrice   = decreaseByPercent(basePrice, targetProfit)
    let band0CeilingPrice = increaseByPercent(basePrice, targetProfit)
    let band0Diff         = (band0CeilingPrice / band0FloorPrice) - 1

    if (this.bandNumber == 0) {
      this.floorPrice   = band0FloorPrice
      this.ceilingPrice = band0CeilingPrice
    } else if (this.bandNumber > 0) {
      this.floorPrice   = band0FloorPrice
      this.ceilingPrice = band0CeilingPrice

      for (var i = 1; i <= this.bandNumber; i++) {
        this.floorPrice = this.ceilingPrice
        this.ceilingPrice = increaseByPercent(this.floorPrice, band0Diff)
      }
    } else {
      this.floorPrice   = band0FloorPrice
      this.ceilingPrice = band0CeilingPrice

      for (var i = -1; i >= this.bandNumber; i--) {
        this.ceilingPrice = this.floorPrice
        this.floorPrice = decreaseByPercent(this.ceilingPrice, band0Diff)
      }
    }

    logAdd(`OperationBand created, ${this.bandNumber}, base ${this.basePrice}, from ${this.floorPrice} to ${this.ceilingPrice}`)
  }

  isPriceBetween(price) {
    return this.floorPrice < price && price <= this.ceilingPrice
  }

  totalBalance() {
    // console.log(this.availableBalance, this.usedBalance())
    return this.availableBalance + this.usedBalance();
  }

  currentTotalBalance(price) {
    let counterToBase = this.counterBalance * price
    return counterToBase + this.availableBalance
  }

  usedBalance() {
    let sum = 0
    this.assets.forEach((item, i) => {
      sum += (item.size * item.price) + item.fee
    })

    return sum;
  }

  usedBalancePerc() {
    return 1 - (this.availableBalance / this.totalBalance())
  }

  avgPrice() {
    if (this.assets.length == 0) {
      return null
    }

    var sum = 0
    var qt = 0
    this.assets.forEach((item, i) => {
      sum += item.size * item.price
      qt  += item.size
    })

    return sum / qt;
  }

  buyingAt() {
    let bal = this.usedBalancePerc()

    if (bal < 0.1) {
      logAdd(`Saldo utilizado na banda menor que 10%, pode comprar a qualquer preço (${(bal * 100).toFixed(1)}%)`)
      return Number.POSITIVE_INFINITY
    }

    let avg = this.avgPrice()

    if (avg == null) {
      return Number.POSITIVE_INFINITY
    }

    // console.log(avg)
    // console.log(this.usedBalancePerc())

    // process.exit(0)

    return decreaseByPercent(avg, (rbData.configs.targetProfit * bal))
  }

  sellingAt() {
    if (this.assets.length == 0) {
      return Number.POSITIVE_INFINITY
    }

    return increaseByPercent(this.assets[0].price, (rbData.configs.targetProfit + rbData.configs.buyingFee + rbData.configs.sellingFee))
  }

  dumpingAt() {
    if (this.assets.length == 0) {
      return 0
    }

    return decreaseByPercent(this.assets[this.assets.length - 1].price, rbData.configs.dumpLimit)
  }

  registerBuyTransaction(transaction) {
    this.assets.push(transaction)
    this.assets.sort((a, b) => a.price - b.price);

    this.results.fees += transaction.fee;

    this.availableBalance -= (transaction.value + transaction.fee)
    this.counterBalance   += transaction.size
  }

  registerSellTransaction(transaction) {
    this.availableBalance += (transaction.value - transaction.fee);
    this.counterBalance   -= transaction.size

    const i = this.assets.findIndex(item => item.id == transaction.buyId)
    const buyTransaction = this.assets[i]

    // console.log(buyTransaction)

    this.assets.splice(i, 1); // 2nd parameter means remove one item only
    this.assets.sort((a, b) => a.price - b.price);

    profit = transaction.value - transaction.fee - buyTransaction.value
    if (profit > 0) {
      this.results.profits += profit
    } else {
      this.results.losses  += Math.abs(profit)
    }

    this.results.fees += transaction.fee
  }

  toString() {
    let sellAt = this.sellingAt()
    if (sellAt == Number.POSITIVE_INFINITY) {
      sellAt = '--'
    } else {
      sellAt = sellAt.toFixed(4)
    }

    return `L: ${this.bandNumber} | ${this.floorPrice.toFixed(4)} -> ${this.ceilingPrice.toFixed(4)} | aB: ${this.availableBalance.toFixed(2)} | cB: ${this.counterBalance.toFixed(2)} | uB: ${this.usedBalance().toFixed(2)} (${(this.usedBalancePerc() * 100).toFixed(1)}%)  ${this.assets.length} | s: ${sellAt} | r: ${(this.results.profits - this.results.losses).toFixed(4)}`
  }
}

class Transaction {
  id
  side
  symbol
  value       //buy: balance spent           / sell: balance received
  size        //buy: counterBalance received / sell: counterBalance spent
  price
  fee
  timestamp

  constructor(blockId, symbol, side, price, value) {
    price = parseFloat(price)

    this.id        = blockId + '-' + generateUID()
    this.side      = side
    this.symbol    = symbol
    this.value     = value           //balance spent / balance received
    this.size      = value / price   //counterBalance received / counterBalance spent
    this.price     = price
    this.fee       = value * rbData.configs.buyingFee
    this.timestamp = Date.now()
  }
}

class BuyTransaction extends Transaction {

  constructor(blockId, symbol, side, price, value) {
    super(blockId, symbol, side, price, value)
  }

}

class SellTransaction extends Transaction {
  buyId

  constructor(blockId, symbol, side, price, value, buyId) {
    super(blockId, symbol, side, price, value)

    this.buyId = buyId
  }
}

class TransactionBlock {
  id
  transactions
  startedAt
  endedAt

  contructor (id) {
    this.id               = id
    this.transactions     = []
    this.startedAt        = Date.now()
    this.endedAt          = null
  }

  addTrasaction(transaction) {
    return this.transactions.push(transaction)
  }

  saveData () {

    let transactionBlockFileName = replaceFileNameTemplate(transactionBlockFileNameTemplate)
    transactionBlockFileName = transactionBlockFileName.replace('{blockId}', this.id)

    fs.writeFileSync(transactionBlockFileName, JSON.stringify(this, null, 2));
  }

  loadData () {

  }

  get transactionCount() {
    return this.transactions.length
  }
}

class TransactionControl {
  transactionCount
  currentBlock
  blocks

  constructor() {
    this.transactionCount = 0
    this.blocks = []

    this.createNewBlock()
  }

  getNextBlockId() {
    part1 = ("000" + this.blocks.length.toString(36)).slice(-3);
  }

  createNewBlock() {
    block = new TransactionBlock(this.getNextBlockId())

    this.blocks.push(block)
    this.currentBlock = block

    this.currentBlock.saveData()

    return block
  }

  closeCurrentBlock() {
    this.currentBlock.endedAt = Date.now() //Trocar para pegar o timestamp da última transação
    this.currentBlock.saveData()
    this.currentBlock = null
  }

  checkCurrentBlock() {
    if (currentBlock.transactionCount >= 5000) {
      this.closeCurrentBlock()
      this.createNewBlock()
    }
  }

  addBuyTransaction(symbol, side, price, value) {
    t = new BuyTransaction(symbol, side, price, value)
    this.transactionCount++

    this.currentBlock.addTrasaction(t)

    this.checkCurrentBlock()

    return t
  }

  addSellTransaction(symbol, side, price, value, buyId) {
    t = new SellTransaction(symbol, side, price, value, buyId)
    this.transactionCount++

    this.currentBlock.addTrasaction(t)

    this.checkCurrentBlock()

    return t
  }

  getTransactionById() {

  }

  getTransactionByBuyId() {
    
  }

  getStats() {
    
  }

  getStatsByInterval(start, end) {
    
  }

}



function increaseByPercent(value, percent) {
  value = parseFloat(value)
  return value + (value * percent)
}

function decreaseByPercent(value, percent) {
  value = parseFloat(value)
  return value - (value * percent)
}

const dataFileName                     = __dirname + '/data.json';
const logFileNameTemplate              = __dirname + '/data/{robotId}/logs/log_{dt}_{hr}.txt';
const transactionBlockFileNameTemplate = __dirname + '/data/{robotId}/transactions/trBlock_{blockId}.txt';

var   logArr = []

//********************************** */
//*********************** Sair com Q */
//********************************** */
readline.emitKeypressEvents(process.stdin);
process.stdin.on('keypress', (ch, key) => {
  // console.log('got "keypress"', ch, key);

  if (key && key.name == 'q') {
    saveData()
    console.log('Bye');
    process.exit(0);
  }
});
process.stdin.setRawMode(true);
process.stdin.resume();
//********************************** */
//*********************** Sair com Q */
//********************************** */


logAdd('------------------------------------------------------- Abertura do programa ' + __filename + ' -------------------------------------------------------')


const config = require('./config');
API.init({
  ...config,
  baseUrl: 'https://api.kucoin.com',
});

const datafeed = new API.websocket.Datafeed();



logAdd(`Reading data file ${dataFileName}`)

var rbData = JSON.parse(fs.readFileSync(dataFileName));

logAdd(`Data file read ${dataFileName}`)


//******* Recuperando do Json e convertendo para o tipo de objeto correto
if (typeof rbData.bands != 'undefined') {
  Object.setPrototypeOf(rbData.bands, BandControl.prototype)

  rbData.bands.bands.forEach((item, i) => {
    Object.setPrototypeOf(item, OperationBand.prototype)
  })
}



if (typeof rbData.robotId == 'undefined' || rbData.robotId == '') {
  rbData.robotId = generateUID()
}


forceDirByFileNameTemplate(dataFileName)
forceDirByFileNameTemplate(logFileNameTemplate)
forceDirByFileNameTemplate(transactionBlockFileNameTemplate)


let prices = []

datafeed.connectSocket();


// subscribe
// const topic = `/market/level2:ADA-USDT`;
// const topic = `/market/ticker:ADA-USDT,ETH-USDT,BTC-USDT`;
const topic = `/market/ticker:ADA-USDT`;
const callbackId = datafeed.subscribe(topic, (message) => {
  // console.log(message);
  if (message.topic == '/market/ticker:ADA-USDT') {
    let wasUndefined = (typeof prices['ADA-USDT']  == 'undefined')

    prices['ADA-USDT'] = parseFloat(message.data.price);

    if (wasUndefined) {
      logAdd(`First price received: ${prices['ADA-USDT']}`)
      // distributeOrders();
    }


  // } else if (message.topic == '/market/ticker:ETH-USDT') {
  //   prices['ETH-USDT'] = message.data.price;
  // } else if (message.topic == '/market/ticker:BTC-USDT') {
  //   prices['BTC-USDT'] = message.data.price;
  }
});
// console.log(`subscribe id: ${callbackId}`);


let robotMessage = '';
const intervalRobo = setInterval(() => {
  rbData.robotLoop++

  if (typeof prices['ADA-USDT'] == 'undefined') {
    rbLogAdd(`No price recieved`)
    return
  }

  rbLogAdd(`ADA price: ${prices['ADA-USDT']}`)


  //Criação das bandas para a primeira execução. 
  //A criação deve ser neste ponto pois aqui é necessário ter o preço base do ativo, e neste ponto é garantido que existe este preço
  if (typeof rbData.bands == 'undefined') {
    rbData.bands = new BandControl(rbData.configs.bandQuantity, rbData.assets.USDT.balance, prices['ADA-USDT'], rbData.configs.targetProfit)
  }

  let curBand = rbData.bands.findBandByPrice(prices['ADA-USDT'])

  rbLogAdd(`Current band: ${curBand.toString()} / Buy At: ${curBand.buyingAt()} / Sell At: ${rbData.bands.sellingAt()} / Dump At: ${rbData.bands.dumpingAt()}`)

  rbData.bands.activateBand(curBand)















  // Dump
  // if (rbData.orders.sell.length > 0) {
  //   if (prices['ADA-USDT'] < rbData.assets.ADA.dumpPoint) {
  //     let lastSellOrder = rbData.orders.sell.pop()
  //     transaction = sell(lastSellOrder, prices['ADA-USDT'])
  //     robotMessage = ` DUMP !!! (ADA ${transaction.size} * $${transaction.price}) - $${transaction.fee} (fee) = $${(transaction.value - transaction.fee)}`;
  //     rbLogAdd(robotMessage)
  //     rbData.lastDump = Date.now();

  //     return;
  //   }
  // }

  // Vendas normais
  while (true) {
    sellAt = rbData.bands.sellingAt()

    if (prices['ADA-USDT'] < sellAt) {
      rbLogAdd(`Não vai vender, está muito barato (sellingAt: ${sellAt})`)
      break;
    }

    asset = rbData.bands.getCheapestAsset()

    rbLogAdd(`Vai vender: ${asset.id}`)
    // console.log(asset)

    transaction = sell(asset, prices['ADA-USDT'])
    rbData.bands.registerSellTransaction(transaction)

    robotMessage = `VENDEU no lucro >  (ADA ${transaction.size} * $${transaction.price}) - $${transaction.fee} (fee) = $${(transaction.value - transaction.fee)}`;
    rbLogAdd(robotMessage)
  }




















  //Compras

  const minimalOrder     = rbData.configs.minimalBuyingOrderAbs
  const maximalOrder     = curBand.availableBalance * rbData.configs.maximalBuyingOrderRel  //compra no máximo x% do saldo por vez
  const secsUntilBuyDump = Math.trunc(rbData.configs.dumpCooldown - ((Date.now() - rbData.lastDump) / 1000)) 
  const secsUntilBuy     = Math.trunc(rbData.configs.buyCooldown  - ((Date.now() - rbData.lastBuy ) / 1000))

  if (curBand.availableBalance < minimalOrder) {
    robotMessage = `Não vai comprar, saldo insuficiente nesta banda (saldo: [${curBand.availableBalance.toFixed(2)}], compra mínima: [${minimalOrder.toFixed(2)}])`;
    rbLogAdd(robotMessage)
    return false;
  }

  if (secsUntilBuyDump >= 0) {
    robotMessage = `Não vai comprar, perdeu dinheiro faz pouco tempo (${secsUntilBuyDump}s)`;
    rbLogAdd(robotMessage)
    return;
  }

  if (secsUntilBuy >= 0) {
    robotMessage = `Não vai comprar, comprou faz pouco tempo (${secsUntilBuy}s)`;
    rbLogAdd(robotMessage)
    return;
  }

  if (prices['ADA-USDT'] > curBand.buyingAt()) {
    robotMessage = `Não vai comprar, está caro (buyingAt: ${curBand.buyingAt()})`;
    rbLogAdd(robotMessage)
    return false;
  }

  let orderVl = Math.max(minimalOrder, maximalOrder)

  transaction = buy(orderVl, prices['ADA-USDT'])
  rbData.bands.registerBuyTransaction(transaction)

  robotMessage = `Buy  <  $${transaction.value.toFixed(4)} / $${transaction.price.toFixed(4)} = ADA ${transaction.size.toFixed(4)} (fee = $${transaction.fee.toFixed(4)}) | id: ${transaction.id})`
  rbLogAdd(robotMessage)

  rbData.lastBuy = Date.now();

}, 1000);

function buy(qtdUSD, price) {
  price = parseFloat(price)

  let transaction = {
    id : generateUID(),
    side : 'buy',
    symbol : 'ADA-USDT',
    value : qtdUSD,
    size : qtdUSD / price,
    price : price,
    fee : qtdUSD * rbData.configs.buyingFee,
    timestamp : Date.now(),
  }

  rbData.transactions.push(transaction)

  rbData.results.fees += transaction.fee;

  rbData.assets.USDT.balance      -= (transaction.value + transaction.fee);
  rbData.assets.USDT.values[0].qt  = rbData.assets.USDT.balance;

  // calcAvgPrice()

  // distributeOrders()

  saveData()

  return transaction
}


function sell(buyTransaction, price) {
  price = parseFloat(price)

  let transaction = {
    id : generateUID(),
    side : 'sell',
    symbol : 'ADA-USDT',
    value : buyTransaction.size * price,
    size : buyTransaction.size,
    price : price,
    fee : buyTransaction.size * price * rbData.configs.sellingFee,
    timestamp : Date.now(),
    buyId : buyTransaction.id,
  }

  rbData.transactions.push(transaction)

  rbData.assets.USDT.balance      += (transaction.value - transaction.fee);
  rbData.assets.USDT.values[0].qt  = rbData.assets.USDT.balance;

  rbData.assets.ADA.balance -= transaction.size;

  const buyTransactions = [buyTransaction.id]


  buyValue = sumTransactionsValues(buyTransactions)
  profit = transaction.value - buyValue
  if (profit > 0) {
    rbData.results.profits += profit
  } else {
    rbData.results.losses += Math.abs(profit)
  }

  rbData.results.fees += transaction.fee

  // calcAvgPrice()

  // distributeOrders()

  saveData()

  return transaction
}


// function calcAvgPrice() {
//   if (rbData.assets.ADA.balance == 0) {
//     rbData.assets.ADA.avgPrice = 0
//     return
//   }

//   let sum = 0
//   rbData.assets.ADA.values.forEach((item, i) => {
//     sum += item.qtd * item.price
//   })

//   rbData.assets.ADA.avgPrice = sum / rbData.assets.ADA.balance;
//   rbData.assets.ADA.dumpPoint    = decreaseByPercent(rbData.assets.ADA.avgPrice, rbData.configs.dumpLimit)
//   rbData.assets.ADA.sellingPoint = increaseByPercent(rbData.assets.ADA.avgPrice, (rbData.configs.targetProfit + rbData.configs.buyingFee + rbData.configs.sellingFee));
// }

function sumTransactionsValues(transactions) {
  arr = getTransactions(transactions)
  sum = arr.map(item => item.value).reduce((prev, next) => prev + next);

  return sum
}

function getTransactions(transactions) {
  if (!Array.isArray(transactions)) {
    transactions = [transactions]
  }

  let ret = []

  transactions.forEach((transId, i) => {
    let transIdx = rbData.transactions.findIndex(item => item.id == transId)

    ret.push(rbData.transactions[transIdx])
  })


  return ret
}



function saveData() {
  fs.writeFileSync(dataFileName, JSON.stringify(rbData, null, 2));
}


function printSellOrders(arr) {
  if (!Array.isArray(arr)) {return ''}
  if (arr.length == 0)     {return ''}
  // if (qtd <= 0)            {return ''}

  let firstSell = arr[0];
  let ret = `$${firstSell.vl.toFixed(6)}  ADA ${firstSell.qt.toFixed(4)}  $${(firstSell.qt * firstSell.vl).toFixed(4)} | `;

  if (arr.length > 1) {
    let lastSell = arr[arr.length - 1];
    ret += `$${lastSell.vl.toFixed(6)}  ADA ${lastSell.qt.toFixed(4)}  $${(lastSell.qt * lastSell.vl).toFixed(4)}`;
  }

  return ret;
}

function printBuyOrders(arr) {
  if (!Array.isArray(arr)) {return ''}
  // if (qtd <= 0)            {return ''}

  let ret = ''

  arr = arr.slice(0, 1);

  arr.forEach((item, i) => {
    ret = ret + '$' + item.vl.toFixed(6) + '  ADA ' + (item.qt / item.vl).toFixed(4) + '  $' + item.qt.toFixed(4) + ' | '
  })

  return ret;
}

function printAssets(arr) {
  if (!Array.isArray(arr)) {return ''}
  if (arr.length <= 0)     {return ''}

  let ret = ''

  if (arr.length > 4) {

    last2 = arr.slice(-2)

    ret = ret + '$' + arr[0].price.toFixed(6) + '  A' + arr[0].qtd.toFixed(6) +' | '
    ret = ret + '$' + arr[1].price.toFixed(6) + '  A' + arr[1].qtd.toFixed(6) +' | '
    ret = ret + '... | '
    ret = ret + '$' + last2[0].price.toFixed(6) + '  A' + last2[0].qtd.toFixed(6) +' | '
    ret = ret + '$' + last2[1].price.toFixed(6) + '  A' + last2[1].qtd.toFixed(6) +' | '
  } else {
    arr.forEach((item, i) => {
      ret = ret + '$' + item.price.toFixed(6) + '  A' + item.qtd.toFixed(6) +' | '
    })
  }

  return ret;
}

function printLastTransactions(qt, side) {
  let arrRet = Array(qt)

  arr = rbData.transactions.slice(-300);
  arr.reverse()

  pos = 0

  arr.forEach((item, i) => {
    if (item.side != side) {
      return false
    }

    if (pos >= qt) {
      return false
    }

    secsSince = Math.trunc((Date.now() - item.timestamp) / 1000)
    arrRet[pos] =  `   ${(secsSince).padLeft(6, ' ')}s   ${item.side.padRight(4, ' ')}   |   ADA${item.size.toFixed(6).padLeft(10, ' ')} * $${item.price.toFixed(6).padLeft(10, ' ')} = $${item.value.toFixed(2).padLeft(7, ' ')}`

    pos++
  })

  return arrRet.join('\n')
}

const intervalLogUpdate = setInterval(async () => {


  // logUpdate.clear();
  // let printBuy = printBuyOrders(rbData.orders.buy)
  // let qtdOrdersBuy = rbData.orders.buy.length

  // let printSell = printSellOrders(rbData.orders.sell)
  // let qtdOrdersSell = rbData.orders.sell.length


  let strAssets = printAssets(rbData.assets.ADA.values)
  // let qtdAssets   = rbData.assets.ADA.values.length

  // process.exit(0)

  // let adaToUS = prices['ADA-USDT'] * rbData.assets.ADA.balance;
  // let totalToUS = adaToUS + rbData.assets.USDT.balance
  // let result = rbData.results.profits - rbData.results.losses - rbData.results.fees

  let stats = rbData.bands.getStats()
  // console.log(stats)
  // process.exit(0)

  if (typeof rbData.bands == 'undefined' || typeof prices['ADA-USDT'] == 'undefined') {
    price   = '---'
    curBand = '---'
    prvBand = '---'
    nxtBand = '---'

    buyAt   = '---'
    sellAt  = '---'
    dumpAt  = '---'

    counterToBaseCurrent = '---'
    totalCurrent         = '---'
  } else {
    price   = prices['ADA-USDT'].toFixed(4)
    curBand = rbData.bands.findBandByPrice(prices['ADA-USDT'])
    prvBand = rbData.bands.getPreviousBand(curBand)
    nxtBand = rbData.bands.getNextBand(curBand)

    buyAt   = curBand.buyingAt().toFixed(4)
    sellAt  = rbData.bands.sellingAt().toFixed(4)
    dumpAt  = rbData.bands.dumpingAt().toFixed(4)

    counterToBaseCurrent = stats.counterBalance * prices['ADA-USDT']
    totalCurrent         = (counterToBaseCurrent + stats.availableBalance).toFixed(2)
    counterToBaseCurrent = counterToBaseCurrent.toFixed(2)
  }


  let percAvail =  ((stats.availableBalance / stats.totalBalance) * 100).toFixed(1)

  // availableBalance: 0,
  // counterBalance: 0,
  // totalBalance: 0,
  // usedBalance:0,
  // assetCount: 0,
  // profits: 0,
  // losses: 0,
  // fees: 0,



  logUpdate(`\n------------------------\n` + 
    `ADA Price      $${price}\n` +
    `Balances       ADA ${stats.counterBalance.toFixed(2)} ($${counterToBaseCurrent})  |  Avail $${stats.availableBalance.toFixed(2)} (${percAvail}%) |  Total $${stats.totalBalance.toFixed(2)}  |  Total Cur $${totalCurrent}\n`+
    `Results        Profits ${stats.profits.toFixed(4)}  -  Losses ${stats.losses.toFixed(4)}  =  ${(stats.profits - stats.losses).toFixed(4)} (Fees ${stats.fees.toFixed(4)})\n`+
    // `ADA AvgPrice   $${rbData.assets.ADA.avgPrice.toFixed(6)} |  Sell at: $${rbData.assets.ADA.sellingPoint.toFixed(6)}  |  Buy at: $${buyAt}  |  Dump at: $${rbData.assets.ADA.dumpPoint.toFixed(6)}\n`+
    `ADA AvgPrice  ??? | BuyAt: ${buyAt} | SellAt: ${sellAt} | Dump At: ${dumpAt}\n`+
    `\n`+
    `Assets (${stats.assetCount.padLeft(3, ' ')})   ${strAssets}\n`+
    `\n`+
    `Msg ${rbData.robotLoop.padLeft(9, ' ')}   ${robotMessage}\n`+
    `\n`+
    `              ${nxtBand.toString()}\n`+
    `Current band: ${curBand.toString()}\n`+
    `              ${prvBand.toString()}\n`+
    `\n`+
    `Transactions (${rbData.transactions.length})\n`+
    `---------- Last 5 Buy\n` +
    `${printLastTransactions(5, 'buy')}\n` +
    `----------Last 5 Sell\n` +
    `${printLastTransactions(5, 'sell')}\n` +
    `----------\n` +
    `Pressione [Q] para sair ${(new Date()).toLocaleString("pt-br").padLeft(60)}`
  );
  // logUpdate.done();
}, 1000);


// function distributeOrders() {

//   let buy = []
//   let sell = []

//   const minimalOrder = rbData.configs.minimalBuyingOrderAbs
//   const maximalOrder = rbData.assets.USDT.balance * rbData.configs.maximalBuyingOrderRel  //compra no máximo x% do saldo por vez

//   if (rbData.assets.USDT.balance > minimalOrder) {
//     if (rbData.assets.ADA.avgPrice > 0) {

//       let adaToUS = prices['ADA-USDT'] * rbData.assets.ADA.balance;
//       let totalToUS = adaToUS + rbData.assets.USDT.balance
//       let used = rbData.assets.USDT.balance / totalToUS

//       orderValue = rbData.assets.ADA.avgPrice - ((rbData.configs.targetProfit * (1 - used)) * rbData.assets.ADA.avgPrice)
//     } else {
//       orderValue = 99999999 //faz esta soma para jÃ¡ sair comprando, neste caso porque nÃ£o tem nada em caixa
//     }

//     orderQtd = Math.max(minimalOrder, maximalOrder)
//     let order = {
//       "id" : generateUID(),
//       "vl" : orderValue,
//       "qt" : orderQtd,
//     }
//     buy.push(order)
//   }


//   //Se a quantidade de ordens for muito grande a ponto de os valores individuais das ordens serem muito pequenos, diminui a quantidade de ordens
//   //No futuro mudar esta lÃ³gica para uma mais simples: ex: o valor da ordem deve ser o maior entre 10% do saldo em USDT e minimalOrder
//   // if (minimalOrder * ordersBuyMax > toDistribute) {
//   //   ordersBuyMax = Math.floor(toDistribute / minimalOrder)
//   // }

//   // let ordersBuy = 1
//   // while (true) {
//   //   if (ordersBuy > ordersBuyMax) {break;}
//   //   if (toDistribute <= 0) {break;}

//   //   orderValue = basePrice - (0.0025 * ordersBuy)
//   //   orderQtd   = Math.min(toDistribute, 1 / ordersBuyMax * rbData.assets.USDT.balance)

//   //   //Checa se o lucro na venda, vai cobrir a taxa
//   //   if (orderQtd < minimalOrder) {break}

//   //   let order = {
//   //     "id" : generateUID(),
//   //     "vl" : orderValue,
//   //     "qt" : orderQtd,
//   //   }

//   //   ordersBuy++;
//   //   toDistribute -= orderQtd;

//   //   buy.push(order)
//   // }

//   rbData.assets.ADA.values.forEach((item, i) => {
//     let order = {
//       "id" : generateUID(),
//       "vl" : item.price + (item.price * (rbData.configs.targetProfit + rbData.configs.sellingFee + rbData.configs.buyingFee)),
//       "qt" : item.qtd,
//       "buyId" : item.id,
//     }

//     sell.push(order)
//   })

//   sell.sort((a,b) => a.vl - b.vl);

//   // rbData.orders.buy = buy
//   // rbData.orders.sell = sell
// }


function generateUID() {
  var part1 = (Math.random() * 46656) | 0;
  var part2 = (Math.random() * 46656) | 0;
  var part3 = (Math.random() * 46656) | 0;
  part1 = ("000" + part1.toString(36)).slice(-3);
  part2 = ("000" + part2.toString(36)).slice(-3);
  part3 = ("000" + part3.toString(36)).slice(-3);
  return part1 + part2 + part3;
}

// Number.prototype.padLeft = function (n, str) {
//   console.log(this, n, str);
//   process.exit(0)
//   return Array(n-String(this).length+1).join(str||'0')+this;
// }



function rbLogAdd(msg) {
  logAdd(`rb:[${rbData.robotLoop.padLeft(9, ' ')}] ${msg}`)
}

function logAdd(msg) {
  logArr.push((new Date()).toDateTimeString() + ' ' + msg)
}


const logFlush = setInterval(() => {
  if (logArr.length == 0) {return false}

  let saveArr = logArr
  logArr = []

  let logFileName = replaceFileNameTemplate(logFileNameTemplate)


  logger(saveArr, logFileName)
  saveArr = []

  // console.log(logFileName)
  // process.exit(1)

}, 1000)


function replaceFileNameTemplate(template) {
  let ret = template

  ret = ret.replace('{dt}'     , (new Date()).to_dt_string())
  ret = ret.replace('{hr}'     , (new Date()).to_hr_string())
  ret = ret.replace('{robotId}', rbData.robotId)

  return ret
}

function forceDirByFileNameTemplate(fileNameTemplate) {
  let fileName = replaceFileNameTemplate(fileNameTemplate)

  let onlyPath = require('path').dirname(fileName);

  if (!fs.existsSync(onlyPath)){
    fs.mkdirSync(onlyPath, { recursive: true });
  }
}


// const { Level2 } = API.websocket;

// Level2.setLogger(() => {});

// const l2 = new Level2('SOL-USDT', datafeed);
// // l2.listen();

// const interval = setInterval(async () => {
  // read orderbook
  // const orderbook = l2.getOrderBook(5);

  // // show Level2
  // let asksStr = '';
  // _.eachRight(orderbook.asks, ([price, size]) => {
  //   asksStr += `${price} -> ${size}\n`;
  // });

  // let bidsStr = '';
  // _.each(orderbook.bids, ([price, size]) => {
  //   bidsStr += `${price} -> ${size}\n`;
  // });

  // logUpdate.clear();
  // logUpdate(`------------------------\n` +
  //   `l2 ${orderbook.dirty ? 'Dirty Data' : 'Trust Data'}\n` +
  //   `l2 seq:  ${orderbook.sequence}\n` +
  //   `ping:    ${orderbook.ping} (ms)\n` +
  //   `------------------------\n` +
  //   `${asksStr}----------sep-----------\n` +
  //   `${bidsStr}------------------------` + random(1000, 9999)
  // );
// }, 1000);
