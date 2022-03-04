// see https://stackoverflow.com/a/19448718
import jsdom from "jsdom";

export default function parseXml(xml, arrayTags) {
  let dom = new jsdom.JSDOM();
  dom = new dom.window.DOMParser();
  dom = dom.parseFromString(xml, "text/xml");
  function parseNode(xmlNode, result) {
    if (xmlNode.nodeName === "#text") {
      let v = xmlNode.nodeValue;
      if (v.trim()) result["#text"] = v;
      return;
    }

    let jsonNode = {},
      existing = result[xmlNode.nodeName];
    if (existing) {
      if (!Array.isArray(existing))
        result[xmlNode.nodeName] = [existing, jsonNode];
      else result[xmlNode.nodeName].push(jsonNode);
    } else {
      if (arrayTags && arrayTags.indexOf(xmlNode.nodeName) !== -1)
        result[xmlNode.nodeName] = [jsonNode];
      else result[xmlNode.nodeName] = jsonNode;
    }

    if (xmlNode.attributes) {
      for (let attribute of xmlNode.attributes) {
        jsonNode[attribute.nodeName] = attribute.nodeValue;
      }
    }

    jsonNode.textContent = xmlNode.textContent;

    for (let node of xmlNode.childNodes) parseNode(node, jsonNode);
  }

  let result = {};
  for (let node of dom.childNodes) parseNode(node, result);

  return result;
}


