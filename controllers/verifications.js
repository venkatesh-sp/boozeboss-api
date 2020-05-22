import models from '../models'
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import async from 'async'
import fetch from 'node-fetch';
import queryString from 'query-string';
import AWS from 'aws-sdk';
import twilio from 'twilio';

const twilio_client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Inititialize AWS 
const s3 = new AWS.S3({
    accessKeyId: process.env.BUCKETEER_AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.BUCKETEER_AWS_SECRET_ACCESS_KEY,
    region: process.env.BUCKETEER_AWS_REGION,
  });

const getVerifications = async (req, res, next) => {
    try {

        const accounts =  
            await models.Account.query()
                .withGraphFetched('[verifications]')
                .where('age_verification_status', 'SUBMITTED')
                .orderBy('created_at', 'desc');
            
        return res.status(200).send(accounts);

    } catch (e) {
        console.log(e);
        return res.status(500).json(JSON.stringify(e)).send();
    }
}

const checkVerificationStatus = async (req, res, next) => { 
    try {
        const {account_id} = req;

        const account = 
            await models.Account.query()
                    .findById(account_id);

        if (account.age_verification_status === 'SUBMITTED') { 
            return res.status(200).json("Your account is under revision. If it isn`t verified before 24 hours. Please contact support@boozeboss.co")
        } 

        if (account.age_verification_status === 'REJECTED') {
            return res.status(200).json("Your account was rejected. If you feel this is an error please contact support@boozeboss.co")
        }

        if (account.age_verification_status === 'APPROVED') {
            return res.status(200).json("Account already approved. Redirecting");
        }

        // If it isn't approved just return 
        return res.status(200).send()

    } catch (e) {
        console.log(e);
        return res.status(500).json(JSON.stringify(e)).send();
    } 
}


// POST - Verification
const uploadVerificationProcess = async (req, res, next) => {
    try {    
        const {account_id} = req;
        const { verification_type} = req.params;
    
        const {file} = req.files;

        const key = `public/verification/${account_id}/${verification_type}/${file.name}`

        let params = {
            Key: key,
            Bucket: process.env.BUCKETEER_BUCKET_NAME,
            Body: file.data,
        }

        await s3.putObject(params, async (err, data) => {
            if (err) {
                console.log(err, err.stack).send();
                return res.status(400).json('Upload failed').send();
            } else {
                
                await models.VerificationAttachment.query()
                    .insert({
                        account_id,
                        url: `https://s3.amazonaws.com/${process.env.BUCKETEER_BUCKET_NAME}/${key}`,
                        file_name: file.name,
                        file_type: file.mimetype,
                        verification_type,
                    })

                return res.status(200).json('Verification successfully uploaded').send();
            }
        })

    } catch (e) {
        console.log(e);
        return res.status(500).json(JSON.stringify(e)).send();
    }
}



const submitVerification = async (req, res, next) => {
    try {
        const {account_id} = req;
        const { age_verification_status } = req.body;

        await models.Account.query()
            .update({ 
                age_verification_status,
            })
            .where('id', account_id);
        
        return res.status(200).json('Submission successfully submitted. We will notify you once your account is approved').send()
        

    } catch (e) {
        console.log(e);
        return res.status(500).json(JSON.stringify(e)).send();
    }
}

// Update verification status to 'APPROVED' or 'REJECTED'
const updateVerificationStatus = async (req, res, next) => { 
    try {
        const {verification_account_id} = req.params; 
        const {age_verification_status} = req.body;
        
        if (age_verification_status === 'APPROVED') { 

            // Update user account
            await models.Account.query()
                    .update({
                        is_age_verified: true,
                        age_verified_at: new Date(),
                        age_verification_status
                    })
                    .where('id', verification_account_id);

                    
            // Delete verification files
            const account = await models.Account.query().findById(verification_account_id).withGraphFetched('[verifications]');
                
            for (const verification of account.verifications) {

                // Delete file by file
                const key = `public/verification/${verification_account_id}/${verification.verification_type}/${verification.file_name}`

                s3.deleteObject({
                    Key: key,
                    Bucket: process.env.BUCKETEER_BUCKET_NAME,
                }, 
                async (err, data) => {
                    if (err) return res.status(400).json('Unable to remove attachment').send();
                    
                    // Delete all the user files
                    await models.VerificationAttachment.query()
                        .delete()
                        .where('id', verification.id);
                })
            }

            // Create Wallet
            await models.Wallet.query()
                .insert({account_id: verification_account_id})
                    
            return res.status(200).json('Profile successfully approved').send();

        } else if (age_verification_status === 'REJECTED') { 

                // Update user account
                await models.Account.query()
                .update({
                    age_verification_status
                })
                .where('id', verification_account_id);
    
                // Delete verification files
                const account = await models.Account.query().findById(verification_account_id).withGraphFetched('[verifications]');
                    
                for (const verification of account.verifications) {

                    // Delete file by file
                    const key = `public/verification/${verification_account_id}/${verification.verification_type}/${verification.file_name}`

                    s3.deleteObject({
                        Key: key,
                        Bucket: process.env.BUCKETEER_BUCKET_NAME,
                    }, 
                    async (err, data) => {
                        if (err) return res.status(400).json('Unable to remove attachment').send();
                        
                        // Delete all the user files
                        await models.VerificationAttachment.query()
                            .delete()
                            .where('id', verification.id);
                    })
                }
                    
                return res.status(200).json('Profile successfully rejected').send();
        }  else {
            return res.status(400).json().send('Invalid status');
        }

        

    } catch (e) {
        console.log(e);
        return res.status(500).json(JSON.stringify(e)).send();
    }
}

// SMS Verifications
const getVerificationSMS =  async (req, res, next) => {
    try {
        const {phone_number} = req.body;
        const verification = 
            await twilio_client.verify.services(process.env.TWILIO_VERIFY_SERVICE_SID)
                    .verifications
                    .create({to: `+${phone_number}`, channel: 'sms'})
                    .then(verification => verification);
            
        if (verification.status === 'pending') {
            return res.status(200).json('SMS successful').send();
        } else {
            return res.status(400).json('Error sending to this number').send();
        }
    
    } catch (e) {
        console.log(e);
        return res.status(500).json(JSON.stringify(e)).send();
    }
}

const checkVerificationSMS =  async (req, res, next) => {
    try {
        const {account_id} = req;
        const {code, phone_number} = req.body;

        const verification = 
            await twilio_client.verify.services(process.env.TWILIO_VERIFY_SERVICE_SID)
            .verificationChecks
            .create({to: `+${phone_number}`, code })
            .then(verification_check => verification_check);
            
        if (verification && verification.status === 'approved') {

            await models.Account.query()
                    .update({is_phone_number_verified: true})
                    .where('id', account_id);
                    
            return res.status(200).json('Success!').send();
        } else { 
            return res.status(400).json('Invalid code').send();
        }
        

    } catch (e) {
        console.log(e);
        return res.status(500).json(JSON.stringify(e)).send();
    }
}



const verificationController = {
    // Verification
    getVerifications,
    checkVerificationStatus,
    uploadVerificationProcess,
    submitVerification,
    updateVerificationStatus,
    // SMS verifications
    getVerificationSMS,
    checkVerificationSMS,
}

export default verificationController;