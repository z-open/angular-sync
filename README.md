### Use Case
Angular Service that allows an array of data or object remain in sync with backend.
If network is lost, the service will handle recovering the missing data.

Client (angular app) subscribes to a publication defined on the server.
The subscription returns an array or object instance that remains in sync.

### Pre-Requisite:
The backend must run the socketio-sync middleware, which is a feature of the socketio-api middleware.

Publications to subscribe to are defined on the server.
 
When the backend writes any data to the db that are supposed to be synchronized:
* It must make sure each add, update, removal of record is timestamped (or increased a revision number)
* It must notify the changes to all publications (with notifyChange or notifyRemoval) with some params so that backend knows that it has to push back the data back to the subscribers/

Sync does not work if objects do not have BOTH id and revision field!!!!

### Example: Syncing an array

### Example: Syncing a record

### Example: Syncing an object

### Example: Syncing from a view state only or limited scope

### Example: Syncing from a service
