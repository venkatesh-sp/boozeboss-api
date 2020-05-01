import models from '../models'
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import fetch from 'node-fetch';
import queryString from 'query-string';

// GET - Get briefs
const getRequisitions = async (req, res, next) => {
    try {    
        
        const {scope, account_id} = req;

        // Validate the collaborators
        let collaborator;
        // If client query client collaborators
        if (scope === 'BRAND') {
            const client_collaborators = 
                        await models.ClientCollaborator.query()
                            .where('account_id', account_id);

            collaborator = client_collaborators[0];
        } 

        // If agency bring Agency collaborators with client graph
        if (scope === 'AGENCY') {
                const agency_collaborators = 
                        await models.AgencyCollaborator.query()
                            .where('account_id', account_id)
                            .withGraphFetched('[client]')
                            
            collaborator = agency_collaborators[0];
        }

        if (!collaborator) return res.status(400).json('Invalid collaborator').send();

        // Get the requisitions
        const requisitions = 
            await models.Requisition.query()
                .withGraphFetched(
                    `[
                        orders.[
                            product.[ingredients]
                        ],
                        brief.[
                            brief_events.[venue], 
                            products.[product]
                        ]
                    ]`
                )
                .modifyGraph('brief', builder => {
                    if (scope === 'AGENCY') {
                        builder.where('agency_id', collaborator.agency_id);
                    }
                    if (scope === 'BRAND') {
                        builder.where('client_id', collaborator.client_id)
                    }                
                })
                .modify((queryBuilder) => {
                    if (scope === 'BRAND') {
                        queryBuilder
                            .whereIn('status', ['SUBMITTED', 'APPROVED', 'DELIVERED']);
                    }
                })
                

        // Send the briefs
        return res.status(200).send(requisitions);

    } catch (e) {
        console.log(e);
        return res.status(500).json(JSON.stringify(e)).send();
    }
}

// POST - Create a new requisition
const createRequisition = async (req, res, next) => {
    try {    
        
        const { scope, account_id} = req;
        const { brief_id, brief_parent_id } = req.body;

        // Validate the collaborators
        const agency_collaborators = 
                        await models.AgencyCollaborator.query()
                            .where('account_id', account_id)
                
        const collaborator = agency_collaborators[0];

        if (!collaborator) return res.status(400).json('Invalid collaborator').send();
                
        // Create a new requisition
        await models.Requisition.query()
            .insert({brief_id, brief_parent_id, status: 'DRAFT'});

        // Update brief status to 'On progress'
        await models.Brief.query()
            .patch({status: 'ON PROGRESS'})
            .where('id', brief_id);

        // Send the briefs
        return res.status(200).json('Requisition created.').send();

    } catch (e) {
        console.log(e);
        return res.status(500).json(JSON.stringify(e)).send();
    }
}

const updateRequisitionStatus = async (req, res, next) => {
    try {

        const {requisition_id} =req.params;
        const { status } = req.body;

        const requisition = 
            await models.Requisition.query().findById(requisition_id);

        await models.Requisition.query()
            .patch({status})
            .where('id', requisition_id);

        await models.Brief.query()
            .patch({status: 'WAITING APPROVAL'})
            .where('id', requisition.brief_id);

        return res.status(200).json('Requisition updated!').send();
        
    } catch (e) {
        console.log(e);
        return res.status(500).json(JSON.stringify(e)).send();
    }
}

const createRequisitionOrder = async (req, res, next) => {
    try {
        const {account_id} = req;
        const {requisition_id} = req.params;
        const {brief_event_id, product_id, price, units, is_display} = req.body;

        await models.RequisitionOrder.query()
            .insert({requisition_id, brief_event_id, product_id, price, units, is_display});

        return res.status(200).json('Order created').send();

    } catch (e) {
        console.log(e);
        return res.status(500).json(JSON.stringify(e)).send();
    }
}

const deleteRequisitionOrder = async (req, res, next) => {
    try {
        const {account_id} = req;
        const {requisition_id, requisition_order_id} = req.params;

        await models.RequisitionOrder.query()
            .deleteById(requisition_order_id);

        return res.status(200).json('Order deleted').send();

    } catch (e) {
        console.log(e);
        return res.status(500).json(JSON.stringify(e)).send();
    }
}

const deliverRequisitionOrders = async (req, res, next) => {
    try {
        const {account_id} = req;
        const {requisition_id} = req.params;
        const {waybill, orders} = req.body;

        // Order comes in form of
        /* 
            {
                product_id: 1,
                units: 100,
                warehouse_id: 1,
            }
        */

         // Validate stock
        for (const order of orders) {

            // Destruct order
            const {product_id, warehouse_id, units} = order;

            // Iteraye trough all stocks
            const stock = 
                await models.WarehouseStock.query()
                    .findOne({
                        product_id,
                        warehouse_id,
                    })

            if (Number(order.units) > Number(stock.quantity)) return res.status(400).json(`Stock unavailable for product with id ${product_id} at warehouse ${warehouse_id}`);
        }

        // If the stock exists for every product
        for (const order of orders) {

            // Destruct order
            const {product_id, warehouse_id, units} = order;

            // Used as an accountability table
            const stocks = 
                await models.WarehouseStock.query()
                    .where('product_id', product_id)
                    .where('warehouse_id', warehouse_id)

            const stock = stocks[0];

            // Record the transaction
            await models.WarehouseTransaction.query()
                    .insert({
                        product_id,
                        warehouse_id, 
                        account_id,
                        requisition_id,
                        quantity: units,
                        action: 'DELIVERY'
                    })
            
            // Update the current amount
            await models.WarehouseStock.query()
                    .update({quantity: Number(stock.quantity) - Number(units)})
                    .where('product_id', product_id)
                    .where('warehouse_id', warehouse_id);
            
        }

        // Update current requisition status
        await models.Requisition.query()
            .update({
                waybill,
                status: 'DELIVERED'
            })
            .where('id', requisition_id);

        // Update brief to READY
        const requisition = await models.Requisition.query().findById(requisition_id);
        await models.Brief.query()
                                .update({status: 'READY'})
                                .where('id', requisition.brief_id);
        
        return res.status(200).json('Order delivered')

    } catch (e) {
        console.log(e);
        return res.status(500).json(JSON.stringify(e)).send();
    }
}


const requisitionController = {
    getRequisitions,
    createRequisition,
    updateRequisitionStatus,
    createRequisitionOrder,
    deleteRequisitionOrder,
    deliverRequisitionOrders
}

export default requisitionController;