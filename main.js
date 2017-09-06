var http = require('http');
var https = require('https');
var validUrl = require('valid-url');
var cheerio = require('cheerio');

/* un esempio, tra parentesi angolari tutti i campi valorizzati dell'header
url: /webvpn/https://ciao.it/cane?ciao=zozzo
method: GET
[host, localhost:8081] 
[connection, keep-alive] 
[upgrade-insecure-requests, 1] 
[user-agent, Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.36] 
[accept, text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*;q=0.8] 
[accept-encoding, gzip, deflate, sdch, br] 
[accept-language, it-IT,it;q=0.8,en-US;q=0.6,en;q=0.4] 
[cookie, eucb=1; cb-enabled=enabled; lang=%25s; ecc.......
*/

  /*
  //qui magia....
  response.writeHead(200, {'Content-Type': 'text/plain'});
  response.write(`url: ${request.url}\n`);
  response.write(`method: ${request.method}\n`);
  for(let key in request.headers) {
    response.write(`[${key}, ${request.headers[key]}] \n`);
  }
  response.write(`body: ${bodyReq}\n`);
  response.write(`url che voglio accedere: ${UrlToGet}\n`);
  response.end();
  */


const ASK_URL_TO_GET_PAGE = `
<!DOCTYPE html> 
<html>
<body>
<form action="go">
tell us where to go:
<input type="text" name="urlparam" value="">
<input type="submit" value="Submit">
</form>
</br>
`

function errToUser(response, errMsg, statusCode) {
  errMsg = `error ${statusCode}, ` + errMsg;
  console.error(errMsg);
  response.statusCode = statusCode;
  response.end(errMsg);
}

//parsedUrl e' un oggetto rstituito da require('url').parse con valorizzato parsedUrl.protocol
function getPortFromUrl(parsedUrl) {
  if(parsedUrl.port != undefined) {
    return parsedUrl.port;
  } else if (parsedUrl.protocol === 'http:') {
    return 80;
  } else if (parsedUrl.protocol === 'https:') {
    return 443;
  } else //impossibile..
    return 0;
}

function replaceUrl(url, pageToAlterUrl) {

  if(url == undefined) {
    return ''; //e' normale che qualche tag abbia l'attributo vuoto
  }

  let urlObj = require('url').parse(url, true, true);
  let pageToAlterUrlObj = require('url').parse(pageToAlterUrl, true, true);

  //se non c'era host, imposto quello corrente
  if(urlObj.host == undefined) {
    urlObj.host = pageToAlterUrlObj.host;
  }

  //se non c'era protocol, imposto quella corrente
  //qui risolvo anche il problema di quando trovo i due slash // all'inizio di un url
  if(urlObj.protocol == undefined) {
    urlObj.protocol = pageToAlterUrlObj.protocol;
  }

  //pulisci la path, assumi che la url corrente sia SEMPRE assoluta
  //se l'url e' relativa, falla diventare assoluta della pageToAlterUrl
  if (urlObj.pathname != undefined && !urlObj.pathname.startsWith('/')) {
    urlObj.pathname = require('url').resolve(pageToAlterUrlObj.pathname, urlObj.pathname);
  }

  //ora bisogna aggiungere /webvpn/ di fronte...
  let retUrl = "/webvpn/" + urlObj.format();
  //console.log(`was: ${url}, prev: ${pageToAlterUrl}, now: ${retUrl})`);
  return retUrl;
 
}

function alterBodyWithRegex(regex, responseBody, pageToAlterUrl) {
  return responseBody.replace(regex, (match, p1, p2, p3) => {
    console.log("ALTERO " + p2);
    let retval = p1 + replaceUrl(p2, pageToAlterUrl) + p3;
    console.log("ALTERATO " + retval);
    return retval;
  });
}

// to bve used as regex in alterBody
const REGEX_TO_ALTER_HTML = [
    //tag a
    /(href\s?=\s?['"])(.*?)(\s?['"])/ig ,
    //tag img, script, ecc
    /(src\s?=\s?['"]\s?)(.*?)(\s?['"])/ig,
    //per i redirect basati su refresh http-equiv
    /(meta\shttp-equiv\s?=\s?['"]refresh['"]\scontent\s?=\s?['"][0-9]+\s?;\s?URL=\s?)(.*?)(\s?['"])/ig
    
]

const REGEX_TO_ALTER_CSS = [
    /(url\s?\(\s?['"]\s?)(.*?)(\s?['"]\s?\))/ig,
    /(import\s['"]\s?)(.*?)(\s?['"])/ig,
]

function alterBody(regexs, responseBody, pageToAlterUrl) {

  let retBody = responseBody;
  for (let reg of regexs) {
    console.log(retBody);
    retBody = alterBodyWithRegex(reg, retBody, pageToAlterUrl);
  }
  return retBody;

}

//dove si va a prendere la pagina da accedere vera e propria
function webvpnPage(bodyReq, originalRequest, originalResponse) {

  // recupera la url richiesta
  let urlToGet = getUrlToGetFromWebVpnUrl(originalRequest.url);
  if (!validUrl.isWebUri(urlToGet)) {
    //bad request, devo sempre avere una url da dover accedere
    errToUser(originalResponse, `webvpnPage: url da accedere malformata o non esistente (${urlToGet})`, 400);
    return;
  }
  console.log(`valid url to fetch: ${urlToGet}`);
  let parsedUrl = require('url').parse(urlToGet);

  //questa e' la porta da contattare nell'host remoto
  let newReqPort = getPortFromUrl(parsedUrl);

  //questo e' l'host da recuperare (senza porta)
  let newReqHost =  parsedUrl.host.replace(/:[0-9]+/, '');
  let newReqHeaders = JSON.parse(JSON.stringify(originalRequest.headers));
  //devo riutilizzare tutti gli header della originalRequest tranne host che e' da cambiare

  //questo qua sotto non funziona per alcuni siti, meglio togliere la porta
  //non so pero' le ripercussioni per quelli che lo chiedono
  //newReqHeaders.host = `${newReqHost}:${newReqPort}`;
  newReqHeaders.host = newReqHost; //`${newReqHost}:${newReqPort}`;

  //devo accettare solo dati non compressi
  newReqHeaders["accept-encoding"] = 'identity';
  //ewReqHeaders["Referer"] = ''; //test //perche' sembra passarlo comunque?

  const newReqOptions = {
    protocol: parsedUrl.protocol, //sempre presente
    host: newReqHost, //vuole host senza porta
    port: newReqPort,
    method: originalRequest.method, //sempre presente
    path: parsedUrl.path, //sempre presente
    headers: newReqHeaders,
    //auth: originalRequest.headers.authorization, //siamo sicuri che funziona? 
    // certe volte chiede credenziali a caso, pensarci successivamente TODO
    //viene cosi': [authorization, Basic Y2lhbzpjYXp6bw==] su test con post: curl --data "p"  http://ciao:cazzo@localhost:8081/webvpn/http://ciao.it
    // timeout: ?
  }

  let proto;
  if (parsedUrl.protocol.includes("https")) {
    proto = https;
  } else if (parsedUrl.protocol.includes("http")) {
    proto = http;
  } else {
    //non succede mai giusto?
  }

  const newReq = proto.request(newReqOptions, (response) => {
    //response.setEncoding('utf8'); // ?? //console.log(`HEADERS: ${JSON.stringify(response.headers)}`);

    // alter Location header in response in case of 3xx status code (redirect)
    // da testare
    if(response.statusCode >= 300 &&
       response.statusCode <= 300 &&
       response.headers.hasOwnProperty('location')) {
        let newLocation = response.headers['location'].replace(/^location:\s/i, '');
        response.headers['location'] == replaceUrl(newLocation, urlToGet);
       }

    originalResponse.writeHead(response.statusCode, response.headers);
    //console.log(newReqOptions);
    //console.log(response.statusCode);

    let contentType = response.headers['content-type']; 

    if (urlToGet.endsWith('css') || ( contentType != undefined && contentType.includes('text/css')) ) {
      alterResponse(response, originalResponse, REGEX_TO_ALTER_CSS, urlToGet);
    }
    else if ( contentType != undefined && contentType.includes('text/html')) {
      alterResponse(response, originalResponse, REGEX_TO_ALTER_HTML, urlToGet);
    }
    else { 
      // per questi non voglio alterare dati
      response.on('data', (chunk) => {
        originalResponse.write(chunk);
      });
      response.on('end', () => {
        originalResponse.end();
      });
    }
  });

  // questo serve per scrivere gli eventali dati di POST
  newReq.on('error', (err) => {
    console.log(`problem with request: ${err.message}`);
  });
  newReq.write(bodyReq);
  newReq.end();

}

function alterResponse(response, originalResponse, regexs, urlToGet) {
  let responseBody = "";
  response.on('data', (chunk) => {
    responseBody += chunk;
  });
  response.on('end', () => {
    let alteredBody = alterBody(regexs, responseBody, urlToGet);
    originalResponse.write(alteredBody);
    originalResponse.end();
  });
}

//risposta alla richiesta di pagina con form dove inserire la pagina da accedere
function askDestinationPage(response) {
  response.end(ASK_URL_TO_GET_PAGE);
}

//qui url e' solo la parte senza host:port
//es di ciao.it:80/webvpn/colazione/xx diventa /colazione/xx
//il param url e' sempre url valida
function getUrlToGetFromWebVpnUrl(url) {
  ////// perche' dovrei? ////////
  //trasformo http(s)/ in http(s)://
  //url = url.replace("https/", "https://");
  //url = url.replace("http/", "http://");
  ///////////////////////////////
  return url.replace('/webvpn/', '');
}

//url che restituisce la pagina di destinazione richiesta tramite parametri 
//qui il param url deve essere sempre valido e di tipo uri http o https
function getWebVpnUrlFromUrlToGet(serverHost, urlToGet) {
  ////// perche' dovrei? ////////
  //encodo http / https all'inizio del path con / al posto dei :  
  // in pratica dobbiamo sostituire :// di http:// in / e basta
  //let urlDestChunk = urlToGet.replace(/:\/\//, '/' );
  ///////////////////////////////
  let urlDestChunk = urlToGet;
  //non serve il path completo, inoltre cosi' mi risparmio di sapere se ho 
  //pubblicato il mio applicativo in http o https
  //return `http://${serverHost}/webvpn/${urlDestChunk}`;
  return `/webvpn/${urlDestChunk}`;
}

function redirectToWebvpnPage(request, response) {
  
  //console.log(require('url').parse(request.url, true).query['urlparam']);
  //prendi parametro get di nome url
  let urlToGet = require('url').parse(request.url, true).query['urlparam'];

  if (urlToGet === undefined || typeof urlToGet !== 'string') {
    //bad request, devo sempre avere il parametro urlToGet qui
    errToUser(response, "redirectToWebvpnPage: parametro GET urlparam non presente o malformato", 400);
    return;
  }

  //se e' omesso il protocollo, aggiungi di default http
  if (!urlToGet.toLowerCase().startsWith('http')) {
    urlToGet = 'http://' + urlToGet;
  }
  
  if (!validUrl.isWebUri(urlToGet)) {
    //bad request, devo sempre avere il parametro urlToGet come url valida qui
    errToUser(response, `redirectToWebvpnPage: parametro GET urlparam non riconosciuto come weburi (${urlToGet})`, 400);
    return;
  }

  //redirect (not permanent) to fetch requested url
  let redirectUrl = getWebVpnUrlFromUrlToGet(request.headers.host, urlToGet);
  response.writeHead(302, {Location: redirectUrl});
  response.end();
}

//url router
function routeReq(request, response) {

  request.on('error', (err) => {
    console.error(err);
  });
  
  let bodyReq = []; //corpo della richiesta (importante in post e put)
  request.on('data', (chunk) => {
    bodyReq.push(chunk);
  });

  //form per richiedere la pagina da accedere
  if (request.url === '/' || request.url === '/askdestination' ) {
    askDestinationPage(response);
  }
  //pagina dove si parsano i parametri del form per accedere alla pagina finale e redirect verso l'api vera e propria
  else if (request.url.startsWith('/go?')) {
    redirectToWebvpnPage(request, response);
  }
  //il cuore, dove si serve la pagina di destinazione vera e propria
  else if (request.url.startsWith('/webvpn/')) {
    request.on('end', () => {
      bodyReq = Buffer.concat(bodyReq).toString();
      webvpnPage(bodyReq, request, response);
    });
  }
  //url non riconosciuta
  else { 
    errToUser(response, `routeReq: url non riconosciuta (${request.url})`, 404);
    return;
  } 
}

// MAIN ////////////////////////////////////////

http.createServer()
  .on('request', routeReq)
  .on('error', (err) => {
    console.error(err);
  })
  .listen(8082); //i cookie non sono specfici per porte

////////////////////////////
