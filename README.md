# SOLO-KMTNet

SOLO: Solarsystem Objects Lightcurve Observatories.

This repository contains SOLO work for KMTNet.

* [observation planning manual](obsplan/README.md) to prepare an observing script.
* The local `test_computation/` directory contains ZIPs with timing enabled and disabled. Git excludes this directory.

In the future, reduction tools will be added.

For photometry: We want this extremely optimized, so we will optimize based on heavy parallelism and optimization using Rust and numba (esp. for WCS).
* [Reducers](https://github.com/ysBach/reducers), [ndfiltrs](https://github.com/ysBach/ndfiltrs), [astroapers](https://github.com/ysBach/astroapers), [skyloc](https://github.com/ysBach/skyloc), [imcombiners](https://github.com/ysBach/imcombiners), [astroimred](https://github.com/ysBach/astroimred) will be used.
