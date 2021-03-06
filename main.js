import { osType, isWindows } from 'https://deno.land/std@0.80.0/_util/os.ts';
import { buildUrl } from 'https://deno.land/x/url_builder/mod.ts';
import { sleep } from 'https://deno.land/x/sleep/mod.ts';
import { exec } from 'https://deno.land/x/exec/mod.ts';
import Random from 'https://deno.land/x/random@v1.1.2/Random.js';
import loadJsonFile from 'https://deno.land/x/load_json_file@v1.0.0/mod.ts';

import mFetch from './fetch.js';
import { logger } from './log.js';
import { getFP } from './browser.js';
import {
  str2Json,
  getCookie,
  cookieParse,
  encodePwd,
  obj2qs,
  genAreaId,
  isInStock,
} from './util.js';

const random = new Random();
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.88 Safari/537.36';
const CONFIG = await loadJsonFile('conf.json');
const skuInfoCache = {};

export default class MonkeyMaster {
  constructor(options = {}) {
    this.options = options;
    this.skuids = options.skuids || [];
    this.userAgent = CONFIG.useRandomUA
      ? this.getRandomUA()
      : DEFAULT_USER_AGENT;
    this.headers = new Headers({
      'User-Agent': this.userAgent,
      'cache-control': 'no-cache',
      'x-requested-with': 'XMLHttpRequest',
    });
    this.userPath = CONFIG.userPath || './cookies/';
    this.isLogged = false;
    this.headers.set('Cookie', '');
  }

  async init() {
    await this.validateCookies();
    const islogin = await this.loginByQRCode();
    if (islogin) {
      logger.info('登录成功了，来造作吧！');
    } else {
      return logger.error('登录失败');
    }

    await this.getUserInfo();
  }

  async checkLoginStatus() {
    await this.validateCookies();
  }

  async validateCookies() {
    const url = buildUrl('https://order.jd.com/center/list.action', {
      queryParams: { rid: Date.now() },
    });

    const res = await mFetch(url);
  }

  async getQRCode() {
    const url = buildUrl('https://qr.m.jd.com/show', {
      queryParams: { appid: 133, size: 147, t: String(Date.now()) },
    });

    const blob = await mFetch(url, {
      method: 'GET',
      referrer: 'https://passport.jd.com/new/login.aspx',
      headers: this.headers,
    }).then((res) => {
      this.saveCookie(res.headers.get('set-cookie'));
      return res.blob();
    });

    console.log(blob.size);
    const buffer = await blob.arrayBuffer();
    const unit8arr = new Deno.Buffer(buffer).bytes();
    Deno.writeFileSync('qrcode.png', unit8arr);
    return await exec(`${isWindows ? 'cmd /c' : 'open'} qrcode.png`);
  }

  async getQRCodeTicket() {
    const url = buildUrl('https://qr.m.jd.com/check', {
      queryParams: {
        callback: `jQuery${random.int(1000000, 9999999)}`,
        appid: 133,
        token: getCookie(this.headers.get('Cookie'), 'wlfstk_smdl'),
        _: String(Date.now()),
      },
    });

    // 只能这样写 referer 才能参数正确，JD 后台贱货
    this.headers.set('Referer', 'https://passport.jd.com/');

    let r = await mFetch(url, {
      method: 'GET',
      body: null,
      headers: this.headers,
    }).then((res) => res.text());

    r = str2Json(r);

    if (r.code === 200) {
      return r.ticket;
    } else {
      logger.error(r.msg);
    }
  }

  async loginByQRCode() {
    const res = await mFetch('https://passport.jd.com/new/login.aspx', {
      headers: this.headers,
    });

    await this.getQRCode();

    const timeLmt = 80 * 1000;
    const startTime = Date.now();
    let ticket;

    while (!ticket && Date.now() - startTime < timeLmt) {
      ticket = await this.getQRCodeTicket();
      await sleep(2);
    }

    // 校验 ticket
    if (ticket) {
      this.headers.set(
        'Referer',
        'https://passport.jd.com/uc/login?ltype=logout'
      );

      const r = await mFetch(
        buildUrl('https://passport.jd.com/uc/qrCodeTicketValidation', {
          queryParams: { t: ticket },
        }),
        {
          method: 'GET',
          headers: this.headers,
          credentials: 'include',
        }
      ).then((res) => {
        this.saveCookie(res.headers.get('set-cookie'));
        return res;
      });

      return r.status === 200;
    }
    return false;
  }

  async getUserInfo() {
    const url = buildUrl(
      'https://passport.jd.com/user/petName/getUserInfoForMiniJd.action',
      {
        queryParams: {
          callback: `jQuery${random.int(1000000, 9999999)}`,
          _: String(Date.now()),
        },
      }
    );

    const res = await mFetch(url, {
      method: 'GET',
      headers: this.headers.set(
        'Referer',
        'https://order.jd.com/center/list.action'
      ),
      // credentials: 'include',
      redirect: 'error',
    });

    const addrs = await this.getUserAddr();

    if (addrs && addrs.length) {
      this.areaId = genAreaId(addrs[0]);
      console.log(`area id 获取成功: ${this.areaId}`);
    }
  }

  async getUserAddr() {
    const url = buildUrl('https://cd.jd.com/usual/address', {
      queryParams: {
        callback: `jQuery${random.int(1000000, 9999999)}`,
        _: String(Date.now()),
      },
    });

    this.headers.set('Referer', 'https://item.jd.com/');

    const res = await mFetch(url, {
      headers: this.headers,
    });

    return str2Json(await res.text());
  }

  saveCookie(cookie) {
    if (cookie === null) return;
    const oldCookie = this.headers.get('Cookie');
    let newCookie = cookieParse(cookie);

    if (oldCookie) {
      newCookie = oldCookie + '; ' + newCookie;
    }

    return this.headers.set('Cookie', newCookie);
    // this.headers['Cookie'] = cookie;
  }

  /**
   *
   * @param {Array} skuids
   */
  async addCart(skuids = []) {
    let url = 'https://cart.jd.com/gate.action';
    const payload = { pcount: 1, ptype: 1 };

    for (let skuid of skuids) {
      url = buildUrl(url, {
        queryParams: {
          pid: skuid,
          ...payload,
        },
      });

      this.headers.set('Referer', `https://item.jd.com/${skuid}.html`);
      const res = await mFetch(url, { headers: this.headers });
      const ret = await this.loginCheck(res.url);

      if (res.status === 200 && ret) {
        logger.info(`商品${skuid}-加车成功`);
      } else {
        logger.info(`商品${skuid}-加车失败`);
        return ret;
      }
    }

    return true;
  }

  /**
   * 订单结算页
   */
  async getOrderInfo() {
    const url = buildUrl(
      'http://trade.jd.com/shopping/order/getOrderInfo.action',
      {
        queryParams: {
          rid: String(Date.now()),
        },
      }
    );

    const res = await mFetch(url);
    logger.info(`订单结算页面响应: ${res.status}`);

    // TODO: parse fingerprint
    // const tdjsCode = await mFetch('https://gias.jd.com/js/td.js').then((res) =>
    //   res.text()
    // );
    // new Function('$', tdjsCode)();
    // console.log(_JdJrTdRiskFpInfo);
    logger.info('获取必要信息中，大约需要30秒');

    if (this.options.fp && this.options.eid) {
      this.fp = this.options.fp;
      this.eid = this.options.eid;
    } else {
      const { fp, eid } = await getFP(this.userAgent);
      this.fp = fp;
      this.eid = eid;
      logger.critical(`fp获取成功, fp: ${fp}, eid: ${eid}`);
    }

    await this.changeOrderAddr(this.areaId);
  }

  async submitOrder() {
    const url = 'https://trade.jd.com/shopping/order/submitOrder.action';
    const {
      eid = this.eid,
      fp = this.fp,
      riskControl,
      password,
    } = this.options;

    const payload = {
      overseaPurchaseCookies: '',
      vendorRemarks: '[]',
      'submitOrderParam.sopNotPutInvoice': 'false',
      // 'submitOrderParam.presalePayType': 1,   # 预售
      'submitOrderParam.trackID': 'TestTrackId',
      'submitOrderParam.ignorePriceChange': '0',
      'submitOrderParam.btSupport': '0',
      // riskControl: '',
      'submitOrderParam.isBestCoupon': 1,
      'submitOrderParam.jxj': 1,
      'submitOrderParam.trackId': 'TestTrackId',
      // 'submitOrderParam.payType4YuShou': 1,    # 预售
      'submitOrderParam.eid': eid,
      'submitOrderParam.fp': fp,
      'submitOrderParam.needCheck': 1,
    };

    if (password) {
      payload['submitOrderParam.payPassword'] = encodePwd(password);
    }

    const headers = new Headers(this.headers);
    headers.set('Host', 'trade.jd.com');
    headers.set(
      'Referer',
      'http://trade.jd.com/shopping/order/getOrderInfo.action'
    );
    headers.set('content-type', 'application/x-www-form-urlencoded');

    logger.info(`submit_order req start at ${Date()}`);

    const res = await mFetch(url, {
      method: 'POST',
      headers,
      body: obj2qs(payload),
    });

    const retJson = await res.json();
    logger.critical(retJson);

    return retJson.success === true;
  }

  /**
   * 定时下单
   * @param {string} time "yyyy-MM-dd HH:mm:ss.SSS"
   */
  async buyOnTime(time) {
    if (!time) return;
    const setTimeStamp = Date.parse(time);
    const runOrder = async () => {
      await this.cancelSelectCartSkus();
      await this.addCart(this.skuids);
      await this.getOrderInfo();
      await this.submitOrder();
    };

    // let now = Date.now();
    let jdTime = Date.parse(await this.timeSyncWithJD());

    let timer = setTimeout(runOrder, setTimeStamp - jdTime);

    while (setTimeStamp > jdTime) {
      // 30秒同步一次时间
      await sleep(30);
      clearTimeout(timer);

      jdTime = Date.parse(await this.timeSyncWithJD());
      timer = setTimeout(runOrder, setTimeStamp - jdTime);

      logger.info(`距离抢购还剩 ${setTimeStamp - jdTime} 秒`);
    }
  }

  async timeSyncWithJD() {
    const res = await mFetch('https://a.jd.com//ajax/queryServerData.html');
    return res.headers.get('date');
  }

  /**
   *
   *
   * @param {number} [interval=5]   轮询间隔，单位秒
   * @memberof MonkeyMaster
   */
  async buySingleSkuInStock(interval = 5) {
    const skuid = this.skuids[0];
    let isInStock = false;

    this.prepareToOrder(skuid);

    while (!isInStock) {
      const skuStockInfo = await this.getSkuStockInfo([skuid], this.areaId);
      isInStock = isInStock(skuStockInfo[skuid]);

      logger.debug(`${skuid}暂无库存，${interval}秒后再次查询`);
      await sleep(interval);
    }

    logger.info(`${skuid}好像有货了喔，下单试试`);

    if (await this.submitOrder()) {
      return true;
    } else {
      return await this.buySingleSkuInStock(interval);
    }
  }

  async buyMultiSkusInStock(interval = 5) {
    let theSkuInStock = null;

    while (!theSkuInStock) {
      const skuStockInfo = await this.getSkuStockInfo(this.skuids, this.areaId);

      theSkuInStock = this.skuids.some((skuid) =>
        isInStock(skuStockInfo[skuid])
      );

      logger.debug(`${this.skuids}暂无库存，${interval}秒后再次查询`);

      await sleep(interval);
    }

    logger.info(`${theSkuInStock}好像有货了喔，下单试试`);

    this.prepareToOrder(theSkuInStock);

    if (await this.submitOrder()) {
      return true;
    } else {
      return await this.buyMultiSkusInStock(interval);
    }
  }

  /**
   *
   * 下单准备（清空-加车-结算）
   * @param {Number} skuid
   * @returns
   */
  async prepareToOrder(skuid) {
    await this.cancelSelectCartSkus();

    const cart = await this.getCartInfo();
    const skuDetails = cart.find((sku) => sku.item.Id == skuid);

    if (skuDetails) {
      logger.info(`${skuid}在购物车中，尝试勾选ing`);
      const isSelected = await this.cartItemSelectToggle(skuDetails, 1);

      if (!isSelected) {
        return logger.critical('商品勾选失败，检查配置');
      }
    } else {
      logger.info(`${skuid}不在购物车中，尝试加车ing`);
      await this.addCart(this.skuids);
    }

    await this.getOrderInfo();
  }

  async loginCheck(url) {
    if (/login\.aspx/g.test(url)) {
      return await this.loginByQRCode();
    } else {
      return true;
    }
  }

  /**
   *
   *
   * @param {Array} skuids
   * @param {String} areaId
   */
  async getSkuStockInfo(skuids, areaId) {
    const url = buildUrl('https://c0.3.cn/stocks', {
      queryParams: {
        callback: `jQuery${random.int(1000000, 9999999)}`,
        type: 'getstocks',
        skuIds: skuids.join(','),
        area: areaId,
        _: String(Date.now()),
      },
    });

    const res = await mFetch(url, {
      headers: this.headers,
      timeout: 5000,
    }).then((r) => r.text());
    let stockInfo = {};
    try {
      stockInfo = str2Json(res);
    } catch (error) {
      return false;
    }

    logger.info(`库存信息: ${JSON.stringify(stockInfo)}`);

    return stockInfo;
  }

  async getCartInfo() {
    const url = buildUrl('https://api.m.jd.com/api', {
      queryParams: {
        functionId: 'pcCart_jc_getCurrentCart',
        appid: 'JDC_mall_cart',
        loginType: 3,
      },
    });

    const payload = {
      serInfo: {
        area: this.areaId,
        'user-key': getCookie(this.headers.get('Cookie'), 'user-key'),
      },
      cartExt: {
        specialId: 1,
      },
    };

    this.headers.set('Referer', 'https://cart.jd.com/');

    const res = await mFetch(url, {
      headers: this.headers,
      body: JSON.stringify(payload),
    });

    let cartInfo = await res.json();
    let vendors = [];
    let ret = [];

    try {
      cartInfo = cartInfo['resultData']['cartInfo'];
      vendors = cartInfo['vendors'];

      for (let vendor of vendors) {
        ret = ret.concat(vendor['sorted']);
      }
    } catch (error) {}

    return ret;
  }

  async cancelSelectCartSkus() {
    const url = 'https://cart.jd.com/cancelAllItem.action';
    const payload = {
      t: 0,
      outSkus: '',
      random: random.int(1e6, 1e7),
    };

    const res = await mFetch(url, {
      payload: JSON.stringify(payload),
    });

    this.saveCookie(res.headers.get('set-cookie'));
    return res.headers.status === 200;
  }

  /**
   * 修改购物车中商品勾选切换，并可修改数量
   * @param {Object} singleItem sku details
   * @param {Number} count 勾选数量
   */
  async cartItemSelectToggle(singleItem, count) {
    const {
      item: { olderVendorId, Id, skuUuid, useUuid },
      checkedNum,
    } = singleItem;

    const payload = {
      operations: [
        {
          TheSkus: [
            {
              Id,
              num: count || checkedNum,
              skuUuid,
              useUuid,
            },
          ],
        },
      ],
      serInfo: { area: this.areaId },
    };

    const url = buildUrl('https://api.m.jd.com/api', {
      queryParams: {
        functionId: 'pcCart_jc_changeSkuNum',
        appid: 'JDC_mall_cart',
        loginType: 3,
        body: JSON.stringify(payload),
      },
    });

    this.headers.set('Referer', 'https://cart.jd.com/');

    const res = await mFetch(url, {
      method: 'POST',
      headers: this.headers,
    }).then((r) => r.json());

    return res.code === 0;
  }

  async changeOrderAddr(areaId) {
    const [provinceId, cityId, countyId, townId] = areaId
      .split('_')
      .map((item) => Number(item));

    const headers = new Headers(this.headers);
    headers.set('Host', 'trade.jd.com');
    headers.set(
      'Referer',
      'http://trade.jd.com/shopping/order/getOrderInfo.action'
    );
    headers.set('content-type', 'application/x-www-form-urlencoded');

    await mFetch(
      'https://trade.jd.com/shopping/dynamic/consignee/checkOpenConsignee.action',
      {
        method: 'POST',
        headers,
        body: obj2qs({
          'consigneeParam.provinceId': provinceId,
          'consigneeParam.cityId': cityId,
          'consigneeParam.countyId': countyId,
          'consigneeParam.townId': townId,
        }),
      }
    );

    await mFetch(
      'https://trade.jd.com/shopping/dynamic/payAndShip/getAdditShipmentNew.action',
      {
        method: 'POST',
        headers,
        body: obj2qs({
          paymentId: 4,
          'shipParam.reset311': 0,
          resetFlag: 1000000000,
          'shipParam.onlinePayType': 0,
          typeFlag: 1,
          promiseTagType: '',
        }),
      }
    );
  }
}
