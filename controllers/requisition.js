import models from '../models'
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import fetch from 'node-fetch';
import queryString from 'query-string';

import { sendRequisitionToEmail, sendDeliveryEmail } from './mailling'

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
                            product.[
                                ingredients.[
                                    brand
                                ],
                                brand
                            ]
                        ],
                        brief.[
                            brief_events.[venue], 
                            brands.[
                                brand
                            ]
                        ],
                        deliveries.[
                            warehouse,
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
                .orderBy('created_at', 'desc')
                
                

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
                            .withGraphFetched('[client]')
                            .where('account_id', account_id)
                
        const collaborator = agency_collaborators[0];

        if (!collaborator) return res.status(400).json('Invalid collaborator').send();
                
        // Create a new requisition
        await models.Requisition.query()
            .insert({
                brief_id, 
                brief_parent_id, 
                status: 'DRAFT', 
                serial_number: collaborator.client.requisition_current_serial + 1
            });

        // Update current client
        await models.Client.query()
            .update({requisition_current_serial: collaborator.client.requisition_current_serial + 1})

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
        const {account_id} = req;
        const {requisition_id} =req.params;
        const { status } = req.body;

        const requisition = 
            await models.Requisition.query()
                    .withGraphFetched(`
                        [
                            client.[
                                client_collaborators.[
                                    account
                                ]
                            ],
                            brief.[
                                agency.[
                                    agency_collaborators.[
                                        account
                                    ]
                                ],
                                brief_events.[
                                    orders.[
                                        product
                                    ]
                                ]
                            ]
                        ]`)
                    .findById(requisition_id);

        await models.Requisition.query()
            .patch({status})
            .where('id', requisition_id);

        // If approved
        if (status === 'APPROVED' ) {
            await models.Brief.query()
                .patch({status: 'APPROVED'})
                .where('id', requisition.brief_id);

            // MAIL notifications
            for (const collaborator of requisition.brief.agency.agency_collaborators) {
                await sendRequisitionToEmail(requisition, collaborator.account, status);
            }

            // Create Events from brief 
            for (const brief_event of requisition.brief.brief_events ) {
                 await models.Event.query()
                        .insert({
                            brief_event_id: brief_event.id,
                            setup_at: brief_event.setup_time,
                            started_at: brief_event.start_time,
                            ended_at: brief_event.end_time,
                        })
            }
        }
        
        // IF SUBMITTED
        if ( status === 'SUBMITTED') {
            await models.Brief.query()
            .patch({status: 'WAITING APPROVAL'})
            .where('id', requisition.brief_id);

            // MAIL notifications
            for (const collaborator of requisition.client.client_collaborators) {
                await sendRequisitionToEmail(requisition, collaborator.account, status);
            }
        }

        // IF REQUEST MODIFICATIONS
        if (status == 'DRAFT') {
            await models.Brief.query()
                .update({status: 'ON PROGRESS'})
                .where('id', requisition.brief_id);
            
            // MAIL notifications
            for (const collaborator of requisition.client.client_collaborators) {
                await sendRequisitionToEmail(requisition, collaborator.account, status);
            }
        }


        return res.status(200).json('Requisition updated!').send();
        
    } catch (e) {
        console.log(e);
        return res.status(500).json(JSON.stringify(e)).send();
    }
}

const rejectRequisition = async (req, res, next) => {
    try {
        const {account_id} = req;
        const {requisition_id} = req.params;

        // Validate the collaborators
        const client_collaborators = 
                        await models.ClientCollaborator.query()
                            .withGraphFetched('[client]')
                            .where('account_id', account_id)
                
        const collaborator = client_collaborators[0];

        if (!collaborator) return res.status(400).json('Invalid collaborator').send();

        // Validate Requisition permission
        const requisition = await models.Requisition.query()
                                .withGraphFetched('[brief]')       
                                .findById(requisition_id);

        if (requisition.brief.client_id !== collaborator.client_id) return res.status(400).json('Invalid client').send();

        await models.Requisition.query()
                .update({status: 'REJECTED'})
                .where('id', requisition_id);

        await models.Brief.query()
                .update({status: 'REQUISITION REJECTED'})
                .where('id', requisition.brief_id)
        
        return res.status(200).json('Status updated').send();

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

/* DEPRECATED */
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

const createRequisitionDelivery = async (req, res, next) => {
    try {
        const {account_id} = req;
        const {requisition_id} = req.params;
        const {waybill, warehouse_id, status, deliveryProducts} = req.body;


        // Validate stock
        for (const deliveryProduct of deliveryProducts) {

            // Destruct order
            const {product, units} = deliveryProduct;

            // Iteraye trough all stocks
            const stock = 
                await models.WarehouseStock.query()
                    .findOne({
                        product_id: product.id,
                        warehouse_id,
                    })

            if (Number(units) > Number(stock.quantity)) return res.status(400).json(`Stock unavailable for product with id ${product_id} at warehouse ${warehouse_id}`);
        }

        const requisition = await models.Requisition.query().findById(requisition_id);

        // Create a new delivery
        const delivery = 
            await models.RequisitionDelivery.query()
                    .insert({
                        requisition_id: Number(requisition_id),
                        waybill: `${requisition.serial_number}_${Math.random().toString(36).substring(7).toUpperCase()}`,
                        status: 'PROCESSING DELIVERY',
                        warehouse_id
                    });

        // If the stock exists for every product
        for (const deliveryProduct of deliveryProducts) {

            // Destruct order
            const {product, units} = deliveryProduct;

            // Used as an accountability table
            
            const stocks = 
                await models.WarehouseStock.query()
                    .where('product_id', product.id)
                    .where('warehouse_id', warehouse_id)

            const stock = stocks[0];

            // Create a Delivery Product
            await models.RequisitionDeliveryProduct.query()
                    .insert({
                        requisition_delivery_id: delivery.id,
                        product_id: product.id,
                        units
                    })

            // Record the transaction
            await models.WarehouseTransaction.query()
                    .insert({
                        product_id: product.id,
                        warehouse_id, 
                        account_id,
                        requisition_id,
                        quantity: units,
                        action: 'DELIVERY'
                    })
            
            // Update the current amount
            await models.WarehouseStock.query()
                    .update({quantity: Number(stock.quantity) - Number(units)})
                    .where('product_id', product.id)
                    .where('warehouse_id', warehouse_id);
            
        }

        // Populate new delivery model to send emails
        const new_delivery = 
            await models.RequisitionDelivery.query()
                .withGraphFetched(`[
                    requisition.[
                        brief.[
                            agency.[
                                agency_collaborators.[
                                    account
                                ]
                            ],
                            brief_events.[
                                orders.[
                                    product
                                ]
                            ]
                        ]
                    ],
                    warehouse,
                    products.[
                        product
                    ]
                ]`)
                .findById(delivery.id)

        for (const collaborator of new_delivery.requisition.brief.agency.agency_collaborators) {
            await sendDeliveryEmail(new_delivery, collaborator.account, 'PROCESSING DELIVERY');
        } 

        return res.status(200).json('Delivery successfull created').send();

    } catch (e) {
        console.log(e);
        return res.status(500).json(JSON.stringify(e)).send();
    }
}

const updateRequisitionDelivery = async (req, res, next) => {
    try {
        const {account_id} = req;
        const {requisition_id, requisition_delivery_id} = req.params;
        const {waybill, status, comments} = req.body;

        await models.RequisitionDelivery.query()
                .update({waybill, status, comments, updated_at: new Date()})
                .where('requisition_id', requisition_id)
                .where('id', requisition_delivery_id);

        // Populate new delivery model to send emails
        const new_delivery = 
            await models.RequisitionDelivery.query()
                .withGraphFetched(`[
                    requisition.[
                        brief.[
                            client.[
                                client_collaborators.[
                                    account
                                ]
                            ],
                            agency.[
                                agency_collaborators.[
                                    account
                                ]
                            ],
                            brief_events.[
                                orders.[
                                    product
                                ]
                            ]
                        ]
                    ],
                    warehouse,
                    products.[
                        product
                    ]
                ]`)
                .findById(requisition_delivery_id)

        // Send email to all client collaborators
        for (const collaborator of new_delivery.requisition.brief.client.client_collaborators) {
            await sendDeliveryEmail(new_delivery, collaborator.account, status);
        }
        
        // Send email to all agency collaborators
        for (const collaborator of new_delivery.requisition.brief.agency.agency_collaborators) {
            await sendDeliveryEmail(new_delivery, collaborator.account, status);
        } 

        return res.status(200).json('Delivery updated successfully').send();

    } catch (e) {
        console.log(e);
        return res.status(500).json(JSON.stringify(e)).send();
    }
}


const requisitionController = {
    getRequisitions,
    createRequisition,
    updateRequisitionStatus,
    rejectRequisition,
    createRequisitionOrder,
    deleteRequisitionOrder,
    deliverRequisitionOrders,
    createRequisitionDelivery,
    updateRequisitionDelivery
}

export default requisitionController;