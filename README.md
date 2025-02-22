THREE-g &mdash; galaxy primitives for playing with THREE.js
=======================================

Generates a mesh of light spots in 3D space, extremely efficiently.

```JavaScript

const m = massSpotMesh({
  spots: [...Array(4000)].map(() => ({
  x: Math.sqrt(Math.random()) * Math.sign(Math.random() - 0.5),
  y: Math.sqrt(Math.random()) * Math.sign(Math.random() - 0.5),
  z: Math.sqrt(Math.random()) * Math.sign(Math.random() - 0.5),
  mass: Math.random() * 0.01,
  rgb: new THREE.Color().setHSL(-Math.sqrt(Math.sqrt(Math.random())) + 1, 1, 0.3).getHex()
  }))
});

```

[Live demo: **https://raw.githack.com/mihailik/three-g/refs/heads/main/index.html**](https://raw.githack.com/mihailik/three-g/refs/heads/main/index.html)

<a href="https://raw.githack.com/mihailik/three-g/refs/heads/main/index.html">

<img alt="Live demo of rotating green cube" src="https://raw.githubusercontent.com/mihailik/three-g/refs/heads/main/demo.gif">

</a>

Mesh parameters
-------------------

* **spots** particles that may have coordinates, colour and mass
* **get** if metrics of the spots are stored elsewhere, you can provide them via this callback

License
-------
MIT &nbsp; [ <img alt="Oleg Mihailik's face" src="https://avatars.githubusercontent.com/u/4041967" width="20" style="border-radius: 1em; margin-bottom: -0.3em"> Oleg Mihailik](https://github.com/mihailik)