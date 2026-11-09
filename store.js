/* ORBAL shop: loads products from the database, product popup, cart and checkout.
   If the store is not connected yet, the page keeps its built-in product list. */
(function () {
  var cfg = window.ORBAL_CONFIG || {};
  var connected = !!(cfg.supabaseUrl && cfg.supabaseAnonKey);
  var CART_KEY = "orbal-cart-v1";
  var CAT_LABELS = { set: "Sets", necklace: "Necklaces", bracelet: "Cuffs & bracelets", earring: "Earrings", hand: "Hand chains", ring: "Rings", other: "Other" };
  var CAT_ORDER = ["set", "necklace", "bracelet", "earring", "hand", "ring", "other"];

  var products = [];
  var settings = { currency: "usd", shipping_us_cents: 500, shipping_world_cents: 2000, free_shipping_over_cents: null, store_open: true };
  var cart = loadCart();

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function money(cents) {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: (settings.currency || "usd").toUpperCase() }).format((cents || 0) / 100);
  }
  function loadCart() { try { var c = JSON.parse(localStorage.getItem(CART_KEY) || "[]"); return Array.isArray(c) ? c : []; } catch (e) { return []; } }
  function saveCart() { try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch (e) {} updateCartCount(); }

  function api(path) {
    return fetch(cfg.supabaseUrl.replace(/\/$/, "") + "/rest/v1/" + path, {
      headers: { apikey: cfg.supabaseAnonKey, Authorization: "Bearer " + cfg.supabaseAnonKey }
    }).then(function (r) { if (!r.ok) throw new Error("load failed"); return r.json(); });
  }

  /* ---------- Product grid ---------- */
  function stockLabel(p) {
    if (p.price_cents == null) return '<span class="stock soon">Coming soon</span>';
    if (p.stock <= 0) return '<span class="stock out">Sold out</span>';
    if (p.stock <= 2) return '<span class="stock low">Only ' + p.stock + " left</span>";
    return '<span class="stock">In stock</span>';
  }

  function renderGrid() {
    var grid = $("grid");
    if (!products.length) {
      grid.innerHTML = '<div class="empty-shop"><h3>New pieces are coming soon</h3><p>Follow us on Instagram to see them first.</p></div>';
      return;
    }
    grid.innerHTML = products.map(function (p) {
      var img = (p.images && p.images[0]) || "images/logo.jpg";
      var price = p.price_cents == null ? "Price coming soon" : money(p.price_cents);
      return '<article class="item" data-cat="' + esc(p.category) + '">' +
        '<button class="ph" type="button" data-open="' + p.id + '" aria-label="View ' + esc(p.name) + '"><img src="' + esc(img) + '" alt="' + esc(p.name) + '" loading="lazy">' + stockLabel(p) + "</button>" +
        "<h3>" + esc(p.name) + "</h3><p>" + esc(p.description) + "</p>" +
        '<div class="row"><span class="price">' + price + '</span><button class="order" type="button" data-open="' + p.id + '">View</button></div></article>';
    }).join("");
  }

  function renderFilters() {
    var box = document.querySelector(".filters");
    if (!box) return;
    var cats = CAT_ORDER.filter(function (c) { return products.some(function (p) { return p.category === c; }); });
    box.innerHTML = '<button class="filter" type="button" data-cat="all" aria-pressed="true">All</button>' +
      cats.map(function (c) { return '<button class="filter" type="button" data-cat="' + c + '" aria-pressed="false">' + CAT_LABELS[c] + "</button>"; }).join("");
  }

  document.addEventListener("click", function (e) {
    var f = e.target.closest(".filter");
    if (f) {
      document.querySelectorAll(".filter").forEach(function (x) { x.setAttribute("aria-pressed", x === f ? "true" : "false"); });
      var c = f.dataset.cat;
      document.querySelectorAll("#grid .item").forEach(function (it) { it.hidden = c !== "all" && (it.dataset.cat || "").split(" ").indexOf(c) === -1; });
      return;
    }
    var o = e.target.closest("[data-open]");
    if (o && connected) { openProduct(o.dataset.open); }
  });

  /* ---------- Product popup ---------- */
  var current = null, lastFocus = null;
  function openProduct(id) {
    var p = products.filter(function (x) { return x.id === id; })[0];
    if (!p) return;
    current = p; lastFocus = document.activeElement;
    var imgs = (p.images && p.images.length) ? p.images : ["images/logo.jpg"];
    $("pm-main").src = imgs[0]; $("pm-main").alt = p.name;
    $("pm-thumbs").innerHTML = imgs.length > 1 ? imgs.map(function (u, i) {
      return '<button type="button" data-img="' + esc(u) + '" aria-label="Photo ' + (i + 1) + '"' + (i === 0 ? ' aria-current="true"' : "") + '><img src="' + esc(u) + '" alt=""></button>';
    }).join("") : "";
    $("pm-cat").textContent = CAT_LABELS[p.category] || "";
    $("pm-name").textContent = p.name;
    $("pm-desc").textContent = p.description;
    $("pm-price").textContent = p.price_cents == null ? "Price coming soon" : money(p.price_cents);
    var canBuy = p.price_cents != null && p.stock > 0 && settings.store_open;
    $("pm-stock").innerHTML = stockLabel(p);
    var qty = $("pm-qty");
    qty.innerHTML = "";
    for (var i = 1; i <= Math.min(Math.max(p.stock, 1), 10); i++) qty.innerHTML += '<option value="' + i + '">' + i + "</option>";
    $("pm-buy-row").hidden = !canBuy;
    $("pm-unavailable").hidden = canBuy;
    $("pm-unavailable").textContent = !settings.store_open ? "The shop is closed for a short break. Please check back soon." :
      p.price_cents == null ? "This piece will be available soon." : "This piece is sold out. Email us to ask about restocks.";
    $("pm-msg").textContent = "";
    $("product-modal").hidden = false;
    document.body.classList.add("lock");
    $("pm-close").focus();
  }
  function closeProduct() { $("product-modal").hidden = true; document.body.classList.remove("lock"); if (lastFocus) lastFocus.focus(); }

  /* ---------- Cart ---------- */
  function cartLines() {
    return cart.map(function (l) { return { line: l, p: products.filter(function (x) { return x.id === l.id; })[0] }; })
      .filter(function (x) { return x.p && x.p.price_cents != null; });
  }
  function addToCart(id, qty) {
    var p = products.filter(function (x) { return x.id === id; })[0];
    var line = cart.filter(function (l) { return l.id === id; })[0];
    var want = (line ? line.qty : 0) + qty;
    if (want > p.stock) { $("pm-msg").textContent = "Only " + p.stock + " available."; return false; }
    if (line) line.qty = want; else cart.push({ id: id, qty: qty });
    saveCart(); return true;
  }
  function updateCartCount() {
    var n = cart.reduce(function (s, l) { return s + l.qty; }, 0);
    document.querySelectorAll("[data-cart-count]").forEach(function (el) { el.textContent = n; });
  }
  function shippingFor(subtotal) {
    var region = $("cart-region").value;
    if (settings.free_shipping_over_cents != null && subtotal >= settings.free_shipping_over_cents) return 0;
    return region === "world" ? settings.shipping_world_cents : settings.shipping_us_cents;
  }
  function renderCart() {
    var lines = cartLines();
    cart = lines.map(function (x) { return x.line; });
    var list = $("cart-list");
    if (!lines.length) {
      list.innerHTML = '<p class="cart-empty">Your cart is empty. Find a piece you love in the collection.</p>';
      $("cart-summary").hidden = true; return;
    }
    list.innerHTML = lines.map(function (x) {
      var p = x.p, l = x.line, img = (p.images && p.images[0]) || "images/logo.jpg", opts = "";
      for (var i = 1; i <= Math.min(Math.max(p.stock, 1), 10); i++) opts += '<option' + (i === l.qty ? " selected" : "") + ">" + i + "</option>";
      return '<div class="cart-line"><img src="' + esc(img) + '" alt=""><div><b>' + esc(p.name) + "</b><span>" + money(p.price_cents) + "</span>" +
        (p.stock < l.qty ? '<span class="warn">Only ' + p.stock + " left</span>" : "") +
        '</div><div class="cart-qty"><label class="sr" for="q-' + p.id + '">Quantity</label><select id="q-' + p.id + '" data-qty="' + p.id + '">' + opts +
        '</select><button type="button" class="link" data-remove="' + p.id + '">Remove</button></div></div>';
    }).join("");
    var subtotal = lines.reduce(function (s, x) { return s + x.p.price_cents * x.line.qty; }, 0);
    var ship = shippingFor(subtotal);
    $("cart-subtotal").textContent = money(subtotal);
    $("cart-shipping").textContent = ship === 0 ? "Free" : money(ship);
    $("cart-total").textContent = money(subtotal + ship);
    var freeNote = $("cart-free");
    if (settings.free_shipping_over_cents != null && subtotal < settings.free_shipping_over_cents) {
      freeNote.textContent = "Add " + money(settings.free_shipping_over_cents - subtotal) + " more for free shipping.";
      freeNote.hidden = false;
    } else freeNote.hidden = true;
    $("cart-summary").hidden = false;
    $("cart-error").hidden = true;
  }
  function openCart() { renderCart(); $("cart").hidden = false; document.body.classList.add("lock"); $("cart-close").focus(); }
  function closeCart() { $("cart").hidden = true; document.body.classList.remove("lock"); }

  function checkout(items, btn, errEl) {
    errEl.hidden = true;
    btn.disabled = true; var old = btn.textContent; btn.textContent = "Opening secure checkout…";
    fetch(cfg.supabaseUrl.replace(/\/$/, "") + "/functions/v1/create-checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: cfg.supabaseAnonKey, Authorization: "Bearer " + cfg.supabaseAnonKey },
      body: JSON.stringify({ items: items, region: $("cart-region").value })
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (res.ok && res.j.url) { window.location.href = res.j.url; return; }
        throw new Error(res.j.error || "Checkout could not start. Please try again.");
      })
      .catch(function (e) {
        errEl.textContent = e.message || "Checkout could not start. Please check your connection and try again.";
        errEl.hidden = false; btn.disabled = false; btn.textContent = old;
      });
  }

  function wireUi() {
    $("pm-close").addEventListener("click", closeProduct);
    $("product-modal").addEventListener("click", function (e) { if (e.target === $("product-modal")) closeProduct(); });
    $("pm-thumbs").addEventListener("click", function (e) {
      var b = e.target.closest("[data-img]"); if (!b) return;
      $("pm-main").src = b.dataset.img;
      $("pm-thumbs").querySelectorAll("button").forEach(function (x) { x.removeAttribute("aria-current"); });
      b.setAttribute("aria-current", "true");
    });
    $("pm-add").addEventListener("click", function () {
      if (addToCart(current.id, parseInt($("pm-qty").value, 10))) { closeProduct(); openCart(); }
    });
    document.querySelectorAll("[data-open-cart]").forEach(function (b) { b.addEventListener("click", openCart); });
    $("cart-close").addEventListener("click", closeCart);
    $("cart").addEventListener("click", function (e) { if (e.target === $("cart")) closeCart(); });
    $("cart-list").addEventListener("change", function (e) {
      var s = e.target.closest("[data-qty]"); if (!s) return;
      cart.forEach(function (l) { if (l.id === s.dataset.qty) l.qty = parseInt(s.value, 10); });
      saveCart(); renderCart();
    });
    $("cart-list").addEventListener("click", function (e) {
      var r = e.target.closest("[data-remove]"); if (!r) return;
      cart = cart.filter(function (l) { return l.id !== r.dataset.remove; }); saveCart(); renderCart();
    });
    $("cart-region").addEventListener("change", renderCart);
    $("cart-checkout").addEventListener("click", function () {
      checkout(cart.map(function (l) { return { id: l.id, qty: l.qty }; }), $("cart-checkout"), $("cart-error"));
    });
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      if (!$("product-modal").hidden) closeProduct(); else if (!$("cart").hidden) closeCart();
    });
  }

  if (!connected) return; // keep the built-in list until the store is connected

  document.documentElement.classList.add("shop-live");
  wireUi();
  updateCartCount();
  Promise.all([
    api("products?select=id,name,description,category,price_cents,stock,images&active=eq.true&order=sort_order.asc,created_at.asc"),
    api("store_settings?select=currency,shipping_us_cents,shipping_world_cents,free_shipping_over_cents,store_open&id=eq.1")
  ]).then(function (res) {
    products = res[0] || [];
    if (res[1] && res[1][0]) settings = res[1][0];
    renderFilters(); renderGrid(); updateCartCount();
    if (/[?&]cart=open/.test(location.search)) openCart();
  }).catch(function () {
    document.documentElement.classList.remove("shop-live");
  });
})();
