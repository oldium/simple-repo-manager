# Things to Do

* Make Repository Management API asynchronous. This should prevent any timeouts
  during the REST API call when `reprepro` and `createrepo_c` calls take a long
  time.
* Make the Repository Management API lock distributed, possible backend is
  Redis. The goal would be to make the server horizontal scalable.
* Add more tests for the rendering engine.
