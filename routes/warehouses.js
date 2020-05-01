var express = require('express');
var router = express.Router();
import warehousesController from '../controllers/warehouses';
import VerifyToken from '../utils/verification'
import VerifyRole from '../utils/verification_role'

/* GET - Get a list of client organizations */
router.get(
    '/', 
    VerifyToken, 
    VerifyRole(['ADMIN', 'BRAND'], ['ADMIN','OWNER', 'MANAGER', 'WAREHOUSE_MANAGER']),
    warehousesController.getWarehouses
);

/* POST - Create a new warehouse */
router.post(
    '/', 
    VerifyToken, 
    VerifyRole(['ADMIN', 'BRAND'], ['ADMIN','OWNER', 'MANAGER']),
    warehousesController.createWarehouse
);

/* POST - Create or update a stock inventory */
router.post(
    '/:warehouse_id/add-stock', 
    VerifyToken, 
    VerifyRole(['BRAND'], ['OWNER', 'WAREHOUSE_MANAGER']),
    warehousesController.createWarehouseStock
);

/* POST - Create or update a stock inventory */
router.post(
    '/:warehouse_id/remove-stock', 
    VerifyToken, 
    VerifyRole(['BRAND'], ['OWNER', 'WAREHOUSE_MANAGER']),
    warehousesController.removeWarehouseStock
);


module.exports = router;